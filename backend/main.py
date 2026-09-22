import os
from dotenv import load_dotenv
import json
import logging
import numpy as np
load_dotenv()
import rasterio
from rasterio.features import shapes
from rasterio.mask import mask
from shapely.geometry import shape, mapping
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pystac_client import Client
import requests
import warnings

# Suppress rasterio notgeoreferenced warning for arbitrary arrays
from rasterio.errors import NotGeoreferencedWarning
warnings.filterwarnings('ignore', category=NotGeoreferencedWarning)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://sylva-sense-gilt.vercel.app",
        "http://localhost:5173",
        "http://127.0.0.1:5173"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO)

STAC_URL = "https://stac.dataspace.copernicus.eu/v1/"
USERNAME = os.environ.get("COPERNICUS_USERNAME")
PASSWORD = os.environ.get("COPERNICUS_PASSWORD")

class AnalysisRequest(BaseModel):
    aoi: dict
    measurement: str

AUTH_CACHE = {"token": None, "expires_at": 0}
STAC_CACHE = {"best_item_dict": None, "expires_at": 0}

@app.get("/api/health")
def health_check():
    # Test catalog connection
    try:
        requests.get(STAC_URL, timeout=5)
        catalog_status = "Connected"
    except:
        catalog_status = "Unavailable"

    return {
        "backend": "Connected",
        "raster": "Ready",
        "sentinel2": catalog_status,
        "sentinel1": catalog_status,
        "copernicus_catalog": catalog_status,
        "authentication": "Configured" if (USERNAME and PASSWORD) else "Not Configured"
    }

def get_token():
    """Retrieve OAuth token for Copernicus Data Space Ecosystem."""
    import time
    if AUTH_CACHE["token"] and time.time() < AUTH_CACHE["expires_at"]:
        logging.info("Reusing cached Copernicus authentication token.")
        return AUTH_CACHE["token"]

    if not USERNAME or not PASSWORD:
        raise ValueError("Copernicus authentication credentials are not configured.")
    
    url = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
    data = {
        "client_id": "cdse-public",
        "username": USERNAME,
        "password": PASSWORD,
        "grant_type": "password",
    }
    
    try:
        resp = requests.post(url, data=data, timeout=10)
        resp.raise_for_status()
        js = resp.json()
        token = js["access_token"]
        expires_in = js.get("expires_in", 600)
        AUTH_CACHE["token"] = token
        AUTH_CACHE["expires_at"] = time.time() + expires_in - 60
        return token
    except Exception as e:
        logging.error(f"Auth failed: {e}")
        raise ValueError("Copernicus authentication failed.")

CACHE_DIR = os.path.join(os.path.dirname(__file__), "cache", "rasters")
os.makedirs(CACHE_DIR, exist_ok=True)

def get_or_download_band(scene_id, band_name, asset_dict, token):
    """Check cache, validate, or download via HTTPS to a .part file."""
    # Find HTTPS alternate URL instead of default S3
    alternates = asset_dict.get("alternate", {})
    if "https" in alternates and "href" in alternates["https"]:
        href = alternates["https"]["href"]
    else:
        href = asset_dict.get("href")
        if href and href.startswith("s3://"):
            raise ValueError("Sentinel-2 asset download failed: S3 URL returned but no HTTPS alternate available.")

    ext = ".jp2" if ".jp2" in href.lower() else ".tif"
    cache_path = os.path.join(CACHE_DIR, f"{scene_id}_{band_name}{ext}")
    part_path = cache_path + ".part"

    # CACHE VALIDATION
    is_valid = False
    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        try:
            with rasterio.open(cache_path) as src:
                _ = src.meta
            is_valid = True
            logging.info(f"CACHE HIT: {band_name}")
        except Exception:
            logging.warning(f"CACHE INVALID: {band_name}")
            os.remove(cache_path)

    # SAFE DOWNLOAD
    if not is_valid:
        logging.info(f"CACHE MISS: downloading {band_name}")
        
        headers = {"Authorization": f"Bearer {token}"}
        resp = requests.get(href, headers=headers, stream=True)
        
        if not resp.ok:
            raise ValueError(f"Sentinel-2 asset download failed: HTTP {resp.status_code}")
            
        try:
            with open(part_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
            os.rename(part_path, cache_path)
        except Exception as e:
            if os.path.exists(part_path):
                os.remove(part_path)
            raise e
            
    return cache_path

def clip_band(local_path, aoi_shape):
    """Clip a local raster using rasterio mask."""
    with rasterio.open(local_path) as src:
        import geopandas as gpd
        aoi_gdf = gpd.GeoDataFrame(geometry=[aoi_shape], crs="EPSG:4326")
        aoi_gdf_proj = aoi_gdf.to_crs(src.crs)
        
        out_image, out_transform = mask(src, [aoi_gdf_proj.geometry.values[0]], crop=True)
        return out_image[0], out_transform, src.crs

@app.post("/api/analyze")
def analyze_aoi(req: AnalysisRequest):
    # Base failure response template
    def make_failure(reason):
        return {
            "status": "REVIEW",
            "api_state": "API_FAILURE",
            "reason": reason,
            "metadata_found": None,
            "computation": None,
            "resolution": {
                "requested": req.measurement,
                "supported": "None",
                "reason": reason
            }
        }

    # Step 1: Parse AOI
    try:
        geom_dict = req.aoi["features"][0]["geometry"] if "features" in req.aoi else req.aoi["geometry"]
        aoi_shape = shape(geom_dict)
    except Exception as e:
        return make_failure("Invalid AOI geometry provided.")

    # Step 2: Query STAC Catalog with Retries and Auth
    import time
    t_start = time.time()
    
    t0 = time.time()
    try:
        token = get_token()
    except ValueError as ve:
        return make_failure(str(ve))
    t_auth = time.time() - t0
    logging.info(f"[PERF] AUTH: {t_auth:.2f}s")
        
    t0 = time.time()
    best_item_dict = None
    if STAC_CACHE["best_item_dict"] and time.time() < STAC_CACHE["expires_at"]:
        best_item_dict = STAC_CACHE["best_item_dict"]
        logging.info("[SCENE CACHE HIT]")
    else:
        logging.info("[SCENE CACHE MISS]")
        stac_search_url = STAC_URL.rstrip('/') + '/search'
        payload = {
            "collections": ["sentinel-2-l2a"],
            "intersects": geom_dict,
            "limit": 3,
            "query": {"eo:cloud_cover": {"lte": 20}},
            "sortby": [{"field": "properties.datetime", "direction": "desc"}]
        }
        
        for attempt in range(1, 4):
            logging.info(f"STAC attempt {attempt}")
            try:
                stac_resp = requests.post(
                    stac_search_url, 
                    json=payload, 
                    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                    timeout=15
                )
                stac_resp.raise_for_status()
                data = stac_resp.json()
                features = data.get("features", [])
                if features:
                    best_item_dict = features[0]
                    STAC_CACHE["best_item_dict"] = best_item_dict
                    STAC_CACHE["expires_at"] = time.time() + 600
                    break
            except requests.exceptions.RequestException as e:
                logging.error(f"STAC search attempt {attempt} failed: {e}")
                if attempt < 3:
                    time.sleep(2 * attempt)
                else:
                    return make_failure(f"Satellite catalog could not be queried after 3 attempts. {str(e)}")
                    
        if not best_item_dict:
            return make_failure("No suitable Sentinel-2 scene was found for this AOI and time window.")
            
    t_stac = time.time() - t0
    logging.info(f"[PERF] STAC: {t_stac:.2f}s")
        
    # Extract metadata
    scene_id = best_item_dict.get("id")
    props = best_item_dict.get("properties", {})
    acq_date = props.get("datetime", "Unknown")
    cloud_cover = props.get("eo:cloud_cover", 0)

    # Check required assets
    assets = best_item_dict.get("assets", {})
    b04_asset = assets.get("B04_10m")
    b08_asset = assets.get("B08_10m")

    # Check Sentinel-1 Connectivity
    s1_connected = False
    try:
        from datetime import datetime, timedelta
        s1_datetime = None
        if acq_date and acq_date != "Unknown":
            try:
                s2_dt = datetime.strptime(acq_date[:10], "%Y-%m-%d")
                dt_start = (s2_dt - timedelta(days=15)).strftime("%Y-%m-%dT00:00:00Z")
                dt_end = (s2_dt + timedelta(days=15)).strftime("%Y-%m-%dT23:59:59Z")
                s1_datetime = f"{dt_start}/{dt_end}"
            except Exception:
                pass
                
        s1_payload = {
            "collections": ["sentinel-1-grd"],
            "intersects": geom_dict,
            "limit": 1,
            "sortby": [{"field": "properties.datetime", "direction": "desc"}]
        }
        if s1_datetime:
            s1_payload["datetime"] = s1_datetime

        logging.info(f"Sentinel-1 check - AOI bounding box: {geom_dict}")
        logging.info(f"Sentinel-1 check - STAC endpoint: {stac_search_url}")
        logging.info(f"Sentinel-1 check - collection being queried: {s1_payload['collections']}")
        logging.info(f"Sentinel-1 check - datetime range: {s1_datetime or '(no explicit range)'}")
        
        s1_resp = requests.post(
            stac_search_url, 
            json=s1_payload, 
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            timeout=10
        )
        
        logging.info(f"Sentinel-1 check - HTTP status code: {s1_resp.status_code}")
        if s1_resp.status_code == 200:
            features = s1_resp.json().get("features", [])
            logging.info(f"Sentinel-1 check - number of Sentinel-1 results returned: {len(features)}")
            if len(features) > 0:
                s1_connected = True
        else:
            logging.error(f"Sentinel-1 check - response error/message: {s1_resp.text}")
    except Exception as e:
        logging.error(f"Sentinel-1 connectivity check failed: {e}")

    metadata = {
        "scene_id": scene_id,
        "acquisition_date": acq_date,
        "cloud_cover": cloud_cover,
        "resolution_m": 10,
        "bands": [],
        "sentinel1_connected": s1_connected,
        "sentinel1_processing": "Not used for this measurement"
    }
    
    logging.info(f"selected scene ID: {scene_id}")
    logging.info(f"acquisition date: {acq_date}")
    logging.info(f"cloud cover: {cloud_cover}")
    
    if b04_asset:
        alt_href = b04_asset.get("alternate", {}).get("https", {}).get("href")
        logging.info(f"asset URL type being used: {'HTTPS alternate' if alt_href else 'Default href'}")

    if b04_asset and b08_asset:
        metadata["bands"] = ["B04", "B08"]
    else:
        resp = make_failure("Required Sentinel-2 bands are unavailable.")
        resp["metadata_found"] = metadata
        return resp

    # Step 4 & 5: Download (or get from cache) & Clip Rasters
    try:
        t0 = time.time()
        b04_path = get_or_download_band(scene_id, "B04", b04_asset, token)
        t_b04 = time.time() - t0
        logging.info(f"[PERF] B04: {t_b04:.2f}s")
        
        t0 = time.time()
        b08_path = get_or_download_band(scene_id, "B08", b08_asset, token)
        t_b08 = time.time() - t0
        logging.info(f"[PERF] B08: {t_b08:.2f}s")
        
        t0 = time.time()
        red_arr, transform, crs = clip_band(b04_path, aoi_shape)
        nir_arr, _, _ = clip_band(b08_path, aoi_shape)
        t_clip = time.time() - t0
        logging.info(f"[PERF] CLIP: {t_clip:.2f}s")
        
    except ValueError as ve:
        # Pass through the specific ValueError (e.g., HTTP 403, 404, etc.)
        logging.error(f"Raster retrieval failed: {ve}")
        resp = make_failure(str(ve))
        resp["metadata_found"] = metadata
        return resp
    except Exception as e:
        logging.error(f"Raster retrieval failed: {e}")
        resp = make_failure("Sentinel-2 raster could not be retrieved.")
        resp["metadata_found"] = metadata
        return resp

    # Step 6: Real NDVI Calculation
    try:
        t0 = time.time()
        # Convert to float for math
        red = red_arr.astype(np.float32)
        nir = nir_arr.astype(np.float32)
        
        # Avoid division by zero
        # CDSE nodata is usually 0
        valid_mask = (red > 0) & (nir > 0)
        valid_pixels = int(np.sum(valid_mask))
        
        if valid_pixels == 0:
            resp = make_failure("Raster processing failed: No valid pixels in AOI.")
            resp["metadata_found"] = metadata
            return resp

        ndvi = np.zeros_like(red)
        np.divide((nir - red), (nir + red), out=ndvi, where=valid_mask)
        
        ndvi_mean = float(np.mean(ndvi[valid_mask]))
        ndvi_min = float(np.min(ndvi[valid_mask]))
        ndvi_max = float(np.max(ndvi[valid_mask]))
        
        # Step 7: Canopy Mask (NDVI-based canopy candidate segmentation)
        NDVI_THRESHOLD = 0.4
        canopy_mask = (ndvi >= NDVI_THRESHOLD) & valid_mask
        canopy_pixels = int(np.sum(canopy_mask))
        canopy_cover_percent = (canopy_pixels / valid_pixels) * 100.0
        
        t_ndvi = time.time() - t0
        logging.info(f"[PERF] NDVI: {t_ndvi:.2f}s")

        # Step 8: Canopy Objects & GeoJSON
        t0 = time.time()
        # Generate polygon geometries from the binary mask
        import geopandas as gpd
        mask_uint8 = canopy_mask.astype(np.uint8)
        
        features = []
        obj_id = 1
        # shapes() yields (geometry, value)
        for geom_val, val in shapes(mask_uint8, mask=mask_uint8, transform=transform):
            if val == 1:
                # Convert to Shapely shape to calculate area (in projected CRS, usually UTM for S2)
                poly = shape(geom_val)
                area_m2 = poly.area
                
                # Filter tiny objects (e.g., < 20 sq meters)
                if area_m2 >= 20:
                    features.append({
                        "type": "Feature",
                        "properties": {
                            "object_id": obj_id,
                            "area_m2": round(area_m2, 1),
                            "source_scene": scene_id,
                            "method": "NDVI-based canopy candidate segmentation (threshold >= 0.4)"
                        },
                        "geometry": geom_val
                    })
                    obj_id += 1
        
        # Reproject GeoJSON back to WGS84 for the frontend map
        if len(features) > 0:
            gdf = gpd.GeoDataFrame.from_features(features, crs=crs)
            gdf_wgs84 = gdf.to_crs("EPSG:4326")
            geojson_dict = json.loads(gdf_wgs84.to_json())
        else:
            geojson_dict = {"type": "FeatureCollection", "features": []}
            
        t_poly = time.time() - t0
        logging.info(f"[PERF] POLYGONIZE: {t_poly:.2f}s")

        t_total = time.time() - t_start
        logging.info(f"[PERF] TOTAL: {t_total:.2f}s")

        # Step 9: Final Response Structure
        return {
            "status": "SUPPORTED" if req.measurement in ["ENUMERATION", "STRUCTURE"] else "REVIEW",
            "api_state": "LIVE",
            "metadata_found": metadata,
            "computation": {
                "ndvi_mean": round(ndvi_mean, 3),
                "ndvi_min": round(ndvi_min, 3),
                "ndvi_max": round(ndvi_max, 3),
                "canopy_cover_percent": round(canopy_cover_percent, 1),
                "valid_pixels": valid_pixels,
                "canopy_objects": len(features),
                "geojson": geojson_dict
            },
            "resolution": {
                "requested": req.measurement,
                "supported": "L3", # Sentinel-2 10m does not support L4 individual tree reliably
                "reason": "Sentinel-2 spatial resolution (10m) does not support reliable individual-tree separation. Returning L3 Canopy Objects."
            }
        }
        
    except Exception as e:
        logging.error(f"Raster processing failed: {e}")
        resp = make_failure("Raster processing failed.")
        resp["metadata_found"] = metadata
        return resp

