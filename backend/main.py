import os
import json
import logging
import numpy as np
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
    allow_origins=["*"],
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
        "copernicus_catalog": catalog_status,
        "authentication": "Configured" if (USERNAME and PASSWORD) else "Not Configured"
    }

def get_token():
    """Retrieve OAuth token for Copernicus Data Space Ecosystem."""
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
        return resp.json()["access_token"]
    except Exception as e:
        logging.error(f"Auth failed: {e}")
        raise ValueError("Copernicus authentication failed.")

def process_band(href, token, aoi_shape):
    """Download and clip a single band using rasterio and GDAL vsi."""
    # Append the authentication header to GDAL via rasterio Env
    env_kwargs = {
        "GDAL_HTTP_HEADERS": f"Authorization: Bearer {token}",
        "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
        "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": "tif,jp2"
    }
    
    with rasterio.Env(**env_kwargs):
        with rasterio.open(href) as src:
            # Transform AOI to raster CRS if needed
            # For simplicity in this backend, assuming GeoJSON AOI is WGS84 (EPSG:4326)
            # and we need to project it to the raster's CRS
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

    # Step 2: Query STAC Catalog
    try:
        catalog = Client.open(STAC_URL)
        search = catalog.search(
            collections=["sentinel-2-l2a"],
            intersects=geom_dict,
            max_items=5,
            query={"eo:cloud_cover": {"lt": 20}}
        )
        items = list(search.items())
        
        if not items:
            return make_failure("No suitable Sentinel-2 scene was found for this AOI and time window.")
            
        best_item = items[0]
    except Exception as e:
        logging.error(f"STAC search failed: {e}")
        return make_failure(f"Satellite catalog could not be queried. {str(e)}")

    # Extract metadata
    scene_id = best_item.id
    acq_date = best_item.datetime.isoformat() if best_item.datetime else "Unknown"
    cloud_cover = best_item.properties.get("eo:cloud_cover", 0)

    # Check required assets
    assets = best_item.assets
    # Copernicus CDSE S2 L2A STAC has B04_10m and B08_10m
    b04_asset = assets.get("B04_10m")
    b08_asset = assets.get("B08_10m")

    metadata = {
        "scene_id": scene_id,
        "acquisition_date": acq_date,
        "cloud_cover": cloud_cover,
        "resolution_m": 10,
        "bands": []
    }

    if b04_asset and b08_asset:
        metadata["bands"] = ["B04", "B08"]
    else:
        # We want to return the metadata we found, but fail the computation
        resp = make_failure("Required Sentinel-2 bands are unavailable.")
        resp["metadata_found"] = metadata
        return resp

    # Step 3: Auth
    try:
        token = get_token()
    except ValueError as ve:
        resp = make_failure(str(ve))
        resp["metadata_found"] = metadata
        return resp

    # Step 4 & 5: Download & Clip Rasters
    try:
        b04_href = b04_asset.href
        b08_href = b08_asset.href
        
        red_arr, transform, crs = process_band(b04_href, token, aoi_shape)
        nir_arr, _, _ = process_band(b08_href, token, aoi_shape)
        
    except Exception as e:
        logging.error(f"Raster retrieval failed: {e}")
        resp = make_failure("Sentinel-2 raster could not be retrieved.")
        resp["metadata_found"] = metadata
        return resp

    # Step 6: Real NDVI Calculation
    try:
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

        # Step 8: Canopy Objects & GeoJSON
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

