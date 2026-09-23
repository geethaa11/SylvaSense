import os
from dotenv import load_dotenv
import json
import logging
import time
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
S3_CRED_CACHE = {}

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
    b_label = band_name.split('_')[0] if '_' in band_name else band_name
    
    try:
        logging.info(f"[S2] {b_label} DOWNLOAD_START")
        
        # Find HTTPS alternate URL instead of default S3
        url_type = "default"
        alternates = asset_dict.get("alternate", {})
        if "https" in alternates and "href" in alternates["https"]:
            href = alternates["https"]["href"]
            url_type = "https alternate"
        else:
            href = asset_dict.get("href")
            if href and href.startswith("s3://"):
                raise ValueError("Sentinel-2 asset download failed: S3 URL returned but no HTTPS alternate available.")

        logging.info(f"[S2] {b_label} URL_TYPE: {url_type} ({href})")

        ext = ".jp2" if ".jp2" in href.lower() else ".tif"
        cache_path = os.path.join(CACHE_DIR, f"{scene_id}_{band_name}{ext}")
        part_path = cache_path + ".part"

        logging.info(f"[S2] {b_label} CACHE_PATH: {cache_path}")
        cache_exists = os.path.exists(cache_path)
        logging.info(f"[S2] {b_label} CACHE_EXISTS: {cache_exists}")

        # CACHE VALIDATION
        is_valid = False
        if cache_exists and os.path.getsize(cache_path) > 0:
            try:
                with rasterio.Env():
                    with rasterio.open(cache_path) as src:
                        _ = src.meta
                is_valid = True
                logging.info(f"[S2] {b_label} CACHE_HIT")
            except Exception as e:
                logging.warning(f"CACHE INVALID: {band_name} - {e}")
                os.remove(cache_path)

        # SAFE DOWNLOAD
        if not is_valid:
            logging.info(f"[S2] {b_label} CACHE_MISS")
            
            headers = {"Authorization": f"Bearer {token}"}
            resp = requests.get(href, headers=headers, stream=True)
            
            logging.info(f"[S2] {b_label} DOWNLOAD_STATUS: HTTP {resp.status_code}")
            if not resp.ok:
                raise ValueError(f"Sentinel-2 asset download failed: HTTP {resp.status_code}")
                
            content_length = resp.headers.get('Content-Length')
            logging.info(f"[S2] {b_label} CONTENT_LENGTH: {content_length}")
                
            try:
                bytes_downloaded = 0
                with open(part_path, "wb") as f:
                    for chunk in resp.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)
                            bytes_downloaded += len(chunk)
                            
                logging.info(f"[S2] {b_label} BYTES_DOWNLOADED: {bytes_downloaded}")
                os.rename(part_path, cache_path)
            except Exception as e:
                if os.path.exists(part_path):
                    os.remove(part_path)
                raise e
                
        logging.info(f"[S2] {b_label} DOWNLOAD_END")
        return cache_path
    except Exception as e:
        import traceback
        logging.error(f"[ERROR] S2 {band_name} processing failed: {e}\n{traceback.format_exc()}")
        raise e

def get_remote_clipped_band(scene_id, band_name, asset_dict, token, aoi_shape):
    """Try remote windowed access via /vsicurl/. Fallback to full download and local clip."""
    b_label = band_name.split('_')[0] if '_' in band_name else band_name
    
    url_type = "default"
    alternates = asset_dict.get("alternate", {})
    if "https" in alternates and "href" in alternates["https"]:
        href = alternates["https"]["href"]
        url_type = "https alternate"
    else:
        href = asset_dict.get("href")
        
    logging.info(f"[S2] {b_label} REMOTE_WINDOW_START")
    logging.info(f"[S2] {b_label} REMOTE_WINDOW_URL_TYPE: {url_type} ({href})")
    logging.info(f"[S2] {b_label} REMOTE_WINDOW_SUPPORTED: Checking")
    
    try:
        import geopandas as gpd
        logging.info(f"[S2] {b_label} REMOTE_WINDOW_READ_START")
        
        # Ensure we use GDAL curl driver and fix OData extension resolution
        # Use standard /vsicurl/ format (GDAL 3+ handles OData redirects better)
        vsi_href = href if href.startswith("/vsi") else ("/vsicurl/" + href.replace("https://", "https://"))
                
        with rasterio.Env(
            GDAL_HTTP_HEADERS=f"Authorization: Bearer {token}",
            GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
            CPL_VSIL_CURL_ALLOWED_EXTENSIONS="tif,jp2,tiff",
            VSI_CACHE="TRUE",
            VSI_CACHE_SIZE="5000000",
            GDAL_HTTP_UNSUPPORTED_REST_METHOD="YES",
            CPL_VSIL_CURL_USE_HEAD="NO"
        ):
            with rasterio.open(vsi_href) as src:
                aoi_gdf = gpd.GeoDataFrame(geometry=[aoi_shape], crs="EPSG:4326")
                aoi_gdf_proj = aoi_gdf.to_crs(src.crs)
                
                # Mask reads ONLY the required window!
                out_image, out_transform = mask(src, [aoi_gdf_proj.geometry.values[0]], crop=True)
                
        logging.info(f"[S2] {b_label} REMOTE_WINDOW_READ_END")
        logging.info(f"[S2] {b_label} REMOTE_WINDOW_SUCCESS")
        return out_image[0], out_transform, src.crs
        
    except Exception as e:
        logging.warning(f"[S2] {b_label} REMOTE_WINDOW_FAILED: {e}")
        logging.info(f"[S2] {b_label} FALLBACK_FULL_DOWNLOAD")
        
        # Fallback to local full download and local clipping
        local_path = get_or_download_band(scene_id, band_name, asset_dict, token)
        return clip_band(local_path, aoi_shape)

S1_CACHE_DIR = os.path.join(os.path.dirname(__file__), "cache", "rasters", "sentinel1")
os.makedirs(S1_CACHE_DIR, exist_ok=True)

def get_or_download_s1_band(scene_id, band_name, asset_dict, token):
    alternates = asset_dict.get("alternate", {})
    if "https" in alternates and "href" in alternates["https"]:
        href = alternates["https"]["href"]
    else:
        href = asset_dict.get("href")
        if href and href.startswith("s3://"):
            raise ValueError("Sentinel-1 asset download failed: S3 URL returned but no HTTPS alternate available.")

    ext = ".tif"
    cache_path = os.path.join(S1_CACHE_DIR, f"{scene_id}_{band_name}{ext}")
    part_path = cache_path + ".part"

    is_valid = False
    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        try:
            with rasterio.Env():
                with rasterio.open(cache_path) as src:
                    _ = src.meta
            is_valid = True
            logging.info(f"CACHE HIT: S1 {band_name}")
        except Exception:
            logging.warning(f"CACHE INVALID: S1 {band_name}")
            os.remove(cache_path)

    if not is_valid:
        logging.info(f"CACHE MISS: downloading S1 {band_name}")
        headers = {"Authorization": f"Bearer {token}"}
        resp = requests.get(href, headers=headers, stream=True, timeout=20)
        if not resp.ok:
            raise ValueError(f"Sentinel-1 asset download failed: HTTP {resp.status_code}")
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
    with rasterio.Env():
        with rasterio.open(local_path) as src:
            import geopandas as gpd
            aoi_gdf = gpd.GeoDataFrame(geometry=[aoi_shape], crs="EPSG:4326")
            aoi_gdf_proj = aoi_gdf.to_crs(src.crs)
            
            out_image, out_transform = mask(src, [aoi_gdf_proj.geometry.values[0]], crop=True)
            return out_image[0], out_transform, src.crs

def process_sentinel1(token, geom_dict, acq_date, aoi_shape):
    s1_connected = False
    s1_used = False
    s1_scene_id = None
    s1_pol = None
    s1_vv_mean = 0.0
    s1_valid_pixels = 0
    s1_processing_msg = "Unavailable"
    s1_reason = "Unknown"
    
    import time
    import numpy as np
    import rasterio
    from rasterio.mask import mask
    import geopandas as gpd
    import xml.etree.ElementTree as ET

    t0_s1 = time.time()
    try:
        logging.info("[S1] AUTH_START")
        
        if S3_CRED_CACHE.get("access_id") and time.time() < S3_CRED_CACHE.get("expires_at", 0):
            aws_access_key = S3_CRED_CACHE["access_id"]
            aws_secret_key = S3_CRED_CACHE["secret"]
        else:
            s3_cred_url = "https://s3-keys-manager.cloudferro.com/api/user/credentials"
            cred_resp = requests.post(s3_cred_url, headers={"Authorization": f"Bearer {token}"}, timeout=10)
            if not cred_resp.ok:
                raise ValueError(f"Failed to fetch S3 credentials: {cred_resp.status_code} {cred_resp.text}")
            
            s3_creds = cred_resp.json()
            
            aws_access_key = s3_creds["access_id"]
            aws_secret_key = s3_creds["secret"]
            S3_CRED_CACHE["access_id"] = aws_access_key
            S3_CRED_CACHE["secret"] = aws_secret_key
            S3_CRED_CACHE["expires_at"] = time.time() + 3600
        
        logging.info("[S1] SEARCH_START")
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
            
        stac_search_url = STAC_URL.rstrip('/') + '/search'
        s1_resp = requests.post(
            stac_search_url, 
            json=s1_payload, 
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            timeout=10
        )
        logging.info("[S1] SEARCH_END")
        
        s1_asset = None
        s1_cal_asset = None
        if s1_resp.status_code == 200:
            features = s1_resp.json().get("features", [])
            if len(features) > 0:
                s1_connected = True
                s1_feature = features[0]
                s1_scene_id = s1_feature.get("id")
                s1_assets = s1_feature.get("assets", {})
                
                for p in ["vv", "vh", "hh", "hv"]:
                    if p in s1_assets:
                        s1_pol = p.upper()
                        s1_asset = s1_assets[p]
                        cal_key = f"schema-calibration-{p}"
                        if cal_key in s1_assets:
                            s1_cal_asset = s1_assets[cal_key]
                        break
                        
                if not s1_asset:
                    s1_reason = "No supported polarization (VV/VH/HH/HV) found in asset keys."
            else:
                s1_reason = "No Sentinel-1 GRD products found matching the AOI and timeframe."
        else:
            s1_reason = f"STAC API returned HTTP {s1_resp.status_code}"
            
        if s1_connected and s1_asset and s1_cal_asset:
            logging.info("[S1] COG_OPEN_START")
            
            href = s1_asset.get("href")
            if not href or not href.startswith("s3://"):
                raise ValueError(f"S1 asset does not have an s3:// href: {href}")
            
            vsi_href = href.replace("s3://", "/vsis3/")
            
            # Setup S3 Env
            import os
            os.environ["AWS_ACCESS_KEY_ID"] = aws_access_key
            os.environ["AWS_SECRET_ACCESS_KEY"] = aws_secret_key
            os.environ["AWS_S3_ENDPOINT"] = "eodata.dataspace.copernicus.eu"
            os.environ["AWS_VIRTUAL_HOSTING"] = "FALSE"
            os.environ["AWS_HTTPS"] = "YES"
            
            with rasterio.Env(
                GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
                VSI_CACHE="TRUE",
                CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.tiff"
            ):
                with rasterio.open(vsi_href) as src:
                    logging.info("[S1] COG_WINDOW_START")
                    
                    min_lon, min_lat, max_lon, max_lat = aoi_shape.bounds
                    
                    if src.transform.is_identity and src.gcps[0]:
                        gcps = src.gcps[0]
                        X = []
                        Y_col = []
                        Y_row = []
                        for gcp in gcps:
                            X.append([gcp.x, gcp.y, 1])
                            Y_col.append(gcp.col)
                            Y_row.append(gcp.row)
                            
                        X = np.array(X)
                        Y_col = np.array(Y_col)
                        Y_row = np.array(Y_row)
                        
                        coeff_col, _, _, _ = np.linalg.lstsq(X, Y_col, rcond=None)
                        coeff_row, _, _, _ = np.linalg.lstsq(X, Y_row, rcond=None)
                        
                        corners = [
                            [min_lon, min_lat, 1],
                            [min_lon, max_lat, 1],
                            [max_lon, min_lat, 1],
                            [max_lon, max_lat, 1]
                        ]
                        
                        cols = [np.dot(c, coeff_col) for c in corners]
                        rows = [np.dot(c, coeff_row) for c in corners]
                        
                        # Buffer
                        min_col = int(max(0, np.min(cols) - 50))
                        max_col = int(min(src.width, np.max(cols) + 50))
                        min_row = int(max(0, np.min(rows) - 50))
                        max_row = int(min(src.height, np.max(rows) + 50))
                        
                        col_offset = min_col
                    else:
                        # If somehow it has a valid transform (e.g. RTC product)
                        aoi_gdf = gpd.GeoDataFrame(geometry=[aoi_shape], crs="EPSG:4326")
                        aoi_gdf_proj = aoi_gdf.to_crs(src.crs)
                        minx, miny, maxx, maxy = aoi_gdf_proj.total_bounds
                        from rasterio.windows import from_bounds
                        win = from_bounds(minx, miny, maxx, maxy, src.transform)
                        min_row, max_row = int(win.row_off), int(win.row_off + win.height)
                        min_col, max_col = int(win.col_off), int(win.col_off + win.width)
                        
                        min_col = max(0, min_col)
                        min_row = max(0, min_row)
                        max_col = min(src.width, max_col)
                        max_row = min(src.height, max_row)
                        col_offset = min_col
                    
                    from rasterio.windows import Window
                    read_window = Window.from_slices((min_row, max_row), (min_col, max_col))
                    s1_arr = src.read(1, window=read_window)
                    
                    logging.info(f"[S1] COG_WINDOW_END (Window size: {s1_arr.shape})")
            
            logging.info("[S1] CALIBRATION_START")
            
            # Fetch calibration XML
            cal_href = s1_cal_asset["alternate"]["https"]["href"]
            cal_resp = requests.get(cal_href, headers={"Authorization": f"Bearer {token}"}, timeout=10)
            if not cal_resp.ok:
                raise ValueError("Failed to fetch calibration XML")
                
            root = ET.fromstring(cal_resp.content)
            pixels = []
            sigma_noughts = []
            
            for vec in root.findall(".//calibrationVector"):
                p_elem = vec.find("pixel")
                s_elem = vec.find("sigmaNought")
                if p_elem is not None and s_elem is not None:
                    p_vals = [float(x) for x in p_elem.text.split()]
                    s_vals = [float(x) for x in s_elem.text.split()]
                    pixels.extend(p_vals)
                    sigma_noughts.extend(s_vals)
            
            if not pixels:
                raise ValueError("No calibration vectors found in XML")
                
            # Interpolate sigmaNought over columns
            pixels = np.array(pixels)
            sigma_noughts = np.array(sigma_noughts)
            # Sort just in case
            sort_idx = np.argsort(pixels)
            pixels = pixels[sort_idx]
            sigma_noughts = sigma_noughts[sort_idx]
            
            h, w = s1_arr.shape
            col_indices = np.arange(col_offset, col_offset + w)
            a_lut = np.interp(col_indices, pixels, sigma_noughts)
            
            # Broadcast a_lut to the image shape (1D -> 2D)
            a_lut_2d = np.tile(a_lut, (h, 1))
            
            logging.info("[S1] CALIBRATION_END")
            
            s1_arr_float = s1_arr.astype(np.float32)
            valid_mask = s1_arr_float > 0
            s1_valid_pixels = int(np.sum(valid_mask))
            
            if s1_valid_pixels > 0:
                # Apply calibration: sigma0 = DN^2 / A^2
                dn_sq = s1_arr_float[valid_mask] ** 2
                a_sq = a_lut_2d[valid_mask] ** 2
                sigma0 = dn_sq / a_sq
                
                # Convert to dB: 10 * log10(sigma0)
                db_arr = 10 * np.log10(sigma0 + 1e-10)
                s1_vv_mean = float(np.mean(db_arr))
                s1_used = True
                s1_processing_msg = f"{s1_pol} Calibrated SAR backscatter"
            else:
                s1_reason = "No valid S1 pixels within the AOI."
            logging.info("[S1] PROCESSING_END")
            
    except requests.exceptions.Timeout:
        s1_reason = "Sentinel-1 STAC API or Download timed out."
        logging.error(f"[S1] exact failure/exception: {s1_reason}")
    except Exception as e:
        import traceback
        s1_reason = f"Exception: {e}"
        logging.error(f"[ERROR] S1 processing failed: {e}\n{traceback.format_exc()}")
        logging.error(f"[S1] exact failure/exception: {s1_reason}")

    t_total = time.time() - t0_s1
    logging.info(f"[S1] TOTAL: {t_total:.2f}s")
    logging.info(f"[S1] final response used={str(s1_used).lower()}")
    
    meta = {
        "sentinel1_connected": s1_connected,
        "sentinel1_used": s1_used,
        "sentinel1_processing": s1_processing_msg
    }
    if not s1_used:
        meta["sentinel1_reason"] = s1_reason
    if s1_used:
        meta["sentinel1_scene"] = s1_scene_id
        meta["sentinel1_polarizations"] = [s1_pol] if s1_pol else []
        meta["sentinel1_statistics"] = {
            "vv_mean_db": round(s1_vv_mean, 2),
            "valid_pixels": s1_valid_pixels
        }
        
    return meta

@app.post("/api/analyze")
def analyze_aoi(req: AnalysisRequest):
    # Base failure response template
    def make_failure(reason):
        resp = {
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
        logging.info(f"[ANALYZE] FINAL RESPONSE (FAILURE): {json.dumps(resp)}")
        return resp

    t0_total = time.perf_counter()
    logging.info(f"[PERF] REQUEST_START: {time.perf_counter() - t0_total:.2f}s")
    try:
        geom_dict = req.aoi["features"][0]["geometry"] if "features" in req.aoi else req.aoi["geometry"]
        aoi_shape = shape(geom_dict)
    except Exception as e:
        return make_failure("Invalid AOI geometry provided.")

    logging.info(f"[PERF] AUTH_START: {time.perf_counter() - t0_total:.2f}s")
    try:
        token = get_token()
    except ValueError as ve:
        return make_failure(str(ve))
    logging.info(f"[PERF] AUTH_END: {time.perf_counter() - t0_total:.2f}s")
        
    logging.info(f"[PERF] STAC_START: {time.perf_counter() - t0_total:.2f}s")
    best_item_dict = None
    stac_search_url = STAC_URL.rstrip('/') + '/search'
    
    if STAC_CACHE["best_item_dict"] and time.time() < STAC_CACHE["expires_at"]:
        best_item_dict = STAC_CACHE["best_item_dict"]
        logging.info("[SCENE CACHE HIT]")
    else:
        logging.info("[SCENE CACHE MISS]")
        from datetime import datetime, timedelta
        now = datetime.utcnow()
        start = now - timedelta(days=90)
        time_str = f"{start.strftime('%Y-%m-%dT%H:%M:%SZ')}/{now.strftime('%Y-%m-%dT%H:%M:%SZ')}"

        payload = {
            "collections": ["sentinel-2-l2a"],
            "datetime": time_str,
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
            
    logging.info(f"[PERF] STAC_END: {time.perf_counter() - t0_total:.2f}s")
        
    # Extract metadata
    scene_id = best_item_dict.get("id")
    props = best_item_dict.get("properties", {})
    acq_date = props.get("datetime", "Unknown")
    cloud_cover = props.get("eo:cloud_cover", 0)

    # Check required assets
    assets = best_item_dict.get("assets", {})
    b04_asset = assets.get("B04_10m")
    b08_asset = assets.get("B08_10m")

    logging.info(f"selected scene ID: {scene_id}")
    logging.info(f"acquisition date: {acq_date}")
    logging.info(f"cloud cover: {cloud_cover}")

    metadata = {
        "scene_id": scene_id,
        "acquisition_date": acq_date,
        "cloud_cover": cloud_cover,
        "resolution_m": 10,
        "bands": []
    }

    # Launch parallel downloads and S1 processing
    import concurrent.futures
    
    logging.info("[ANALYZE] START")
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=3)
    
    logging.info("[ANALYZE] S1 task started")
    s1_future = executor.submit(process_sentinel1, token, geom_dict, acq_date, aoi_shape)
    
    b04_future = None
    b08_future = None
    
    if b04_asset:
        logging.info("[ANALYZE] B04 task started")
        b04_future = executor.submit(get_remote_clipped_band, scene_id, "B04_10m", b04_asset, token, aoi_shape)
    if b08_asset:
        logging.info("[ANALYZE] B08 task started")
        b08_future = executor.submit(get_remote_clipped_band, scene_id, "B08_10m", b08_asset, token, aoi_shape)
        
    # S1 task is running concurrently. We will wait for it after S2 polygonization.
    try:
        logging.info(f"[PERF] B04_START: {time.perf_counter() - t0_total:.2f}s")
        if b04_future:
            red_arr, transform, crs = b04_future.result()
            logging.info("[ANALYZE] B04 task completed")
        else:
            red_arr = None
        logging.info(f"[PERF] B04_END: {time.perf_counter() - t0_total:.2f}s")
        
        logging.info(f"[PERF] B08_START: {time.perf_counter() - t0_total:.2f}s")
        if b08_future:
            nir_arr, _, _ = b08_future.result()
            logging.info("[ANALYZE] B08 task completed")
        else:
            nir_arr = None
        logging.info(f"[PERF] B08_END: {time.perf_counter() - t0_total:.2f}s")
    except Exception as e:
        import traceback
        logging.error(f"[ANALYZE] B04/B08 task failed: {e}\n{traceback.format_exc()}")
        logging.error(f"[ERROR] ANALYZE failed: {e}\n{traceback.format_exc()}")
        resp = make_failure(f"Failed to retrieve Sentinel-2 data: {e}")
        resp["metadata_found"] = metadata
        executor.shutdown(wait=False)
        return resp
        
    executor.shutdown(wait=False)

    if b04_asset:
        alt_href = b04_asset.get("alternate", {}).get("https", {}).get("href")
        logging.info(f"asset URL type being used: {'HTTPS alternate' if alt_href else 'Default href'}")

    if b04_asset and b08_asset:
        metadata["bands"] = ["B04", "B08"]
    else:
        resp = make_failure("Required Sentinel-2 bands are unavailable.")
        resp["metadata_found"] = metadata
        return resp

    # Step 4 & 5: Clip Rasters (Downloads handled concurrently above)
    try:
        logging.info(f"[PERF] CLIP_START: {time.perf_counter() - t0_total:.2f}s")
        # Arrays are already clipped by get_remote_clipped_band
        if red_arr is None or nir_arr is None:
            raise ValueError("Arrays missing after processing.")
        logging.info(f"[PERF] CLIP_END: {time.perf_counter() - t0_total:.2f}s")
        
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
        logging.info(f"[PERF] NDVI_START: {time.perf_counter() - t0_total:.2f}s")
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
        
        logging.info(f"[PERF] NDVI_END: {time.perf_counter() - t0_total:.2f}s")

        # Step 8: Canopy Objects & GeoJSON
        logging.info(f"[PERF] POLYGONIZE_START: {time.perf_counter() - t0_total:.2f}s")
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
            
        logging.info(f"[PERF] POLYGONIZE_END: {time.perf_counter() - t0_total:.2f}s")
        
        # Wait for S1 task here (which has been running concurrently with B04/B08/NDVI)
        s1_meta = {}
        try:
            s1_meta = s1_future.result(timeout=15.0)
            logging.info("[ANALYZE] S1 task completed")
        except concurrent.futures.TimeoutError:
            logging.error("[S1] HARD_TIMEOUT_TRIGGERED: Sentinel-1 operation exceeded total time limit")
            s1_meta = {
                "sentinel1_connected": False,
                "sentinel1_used": False,
                "sentinel1_processing": "Unavailable",
                "sentinel1_reason": "Sentinel-1 operation exceeded time limit"
            }
        except Exception as e:
            import traceback
            logging.error(f"[ANALYZE] S1 task failed: {e}\n{traceback.format_exc()}")
            s1_meta = {
                "sentinel1_connected": False,
                "sentinel1_used": False,
                "sentinel1_processing": "Unavailable",
                "sentinel1_reason": f"S1 task failed: {e}"
            }
        metadata.update(s1_meta)

        # Step 9: Final Response Structure
        logging.info(f"[PERF] RESPONSE_BUILD_START: {time.perf_counter() - t0_total:.2f}s")
        final_resp = {
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
        logging.info(f"[PERF] RESPONSE_BUILD_END: {time.perf_counter() - t0_total:.2f}s")
        logging.info(f"[PERF] REQUEST_TOTAL: {time.perf_counter() - t0_total:.2f}s")
        logging.info(f"[ANALYZE] FINAL RESPONSE: {json.dumps(final_resp)}")
        return final_resp
        
    except Exception as e:
        import traceback
        logging.error(f"Raster processing failed: {e}\n{traceback.format_exc()}")
        resp = make_failure("Raster processing failed.")
        resp["metadata_found"] = metadata
        logging.info(f"[ANALYZE] FINAL RESPONSE: {json.dumps(resp)}")
        return resp

