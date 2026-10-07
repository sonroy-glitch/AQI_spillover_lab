"""
AeroCast backend — single-file Flask server for the pollution-movement dashboard.

Routes consumed by the frontend:
  GET  /api/forecast?city=<id>&hours=24   -> ForecastResponse (lib/pollution/types.ts)
  POST /api/chat                          -> AI SDK UI message stream (SSE)

Extras:
  GET  /api/cities   -> the city list the dashboard's selector uses
  GET  /api/health   -> liveness + which models are loaded

Live data comes from Open-Meteo (no API key required):
  - air-quality-api.open-meteo.com  : pm2_5, pm10, no2, so2, o3, co, nh3, us_aqi
  - api.open-meteo.com              : wind, temperature, humidity
Risk zones (schools / stadiums / outdoor-worker sites) come from OpenStreetMap
via Overpass, with a deterministic synthetic fallback when Overpass is slow.

Horizon AQI (+6/12/18/24h) is predicted by the RandomForest models in ../models,
which expect CPCB-style pollutant features.
"""

from __future__ import annotations

import json
import math
import os
import pickle
import threading
import time
import warnings
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd
import requests
from flask import Flask, Response, jsonify, request, stream_with_context
from flask_cors import CORS

warnings.filterwarnings("ignore")  # sklearn pickle version warnings are noisy but harmless

# --------------------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))

try:  # optional: pip install python-dotenv
    from dotenv import load_dotenv

    load_dotenv(os.path.join(HERE, ".env"))
    DOTENV_AVAILABLE = True
except ImportError:
    DOTENV_AVAILABLE = False
    if os.path.exists(os.path.join(HERE, ".env")):
        print("WARNING: backend/.env exists but python-dotenv is not installed, so it is "
              "being ignored. Run: pip install python-dotenv", flush=True)

# models/ next to app.py is the layout the Docker image uses; ../models is the
# older repo-root layout, kept so an existing checkout still works.
def _default_model_dir() -> str:
    for candidate in (os.path.join(HERE, "models"), os.path.join(HERE, "..", "models")):
        if os.path.isdir(candidate):
            return candidate
    return os.path.join(HERE, "models")


MODEL_DIR = os.environ.get("AQI_MODEL_DIR") or _default_model_dir()
# model_12.pkl (149MB) and model_24.pkl (571MB) exceed GitHub's 100MB file limit, so a
# deployment that builds from a plain git repo has no models baked in. Point this at a
# bucket/release holding model_<h>.pkl and they are fetched on first use instead.
MODEL_BASE_URL = os.environ.get("AQI_MODEL_BASE_URL", "").rstrip("/")
USE_MODELS = os.environ.get("AQI_USE_MODELS", "1") != "0"
WARM_MODELS = os.environ.get("AQI_WARM_MODELS", "1") != "0"   # preload at boot
TREE_SAMPLE = int(os.environ.get("AQI_TREE_SAMPLE", "150"))   # trees polled for the band
USE_OVERPASS = os.environ.get("AQI_USE_OVERPASS", "1") != "0"

# Chat: the groq client appends "/openai/v1" itself, so GROQ_BASE_URL is the bare
# host. Pasting the full OpenAI-compatible URL is the obvious mistake, so trim it.
CHAT_BASE_URL = os.environ.get("GROQ_BASE_URL", "https://api.groq.com").rstrip("/")
if CHAT_BASE_URL.endswith("/openai/v1"):
    CHAT_BASE_URL = CHAT_BASE_URL[: -len("/openai/v1")]
CHAT_MODEL = os.environ.get("AQI_CHAT_MODEL", "openai/gpt-oss-120b")
CHAT_REASONING_EFFORT = os.environ.get("AQI_CHAT_REASONING_EFFORT", "low")
CHAT_MAX_TOKENS = int(os.environ.get("AQI_CHAT_MAX_TOKENS", "800"))

AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
WX_URL = "https://api.open-meteo.com/v1/forecast"
# The public Overpass instance throttles hard; try mirrors in turn before giving up.
OVERPASS_URLS = [u for u in os.environ.get(
    "AQI_OVERPASS_URLS",
    "https://overpass-api.de/api/interpreter,"
    "https://overpass.kumi.systems/api/interpreter,"
    "https://overpass.osm.ch/api/interpreter",
).split(",") if u.strip()]
# Optional: a free token from aqicn.org/data-platform/token adds real monitoring
# stations on top of the modelled field. Everything works without it.
WAQI_TOKEN = os.environ.get("WAQI_TOKEN", "").strip()
USER_AGENT = "AeroCast-Dashboard/1.0 (air-quality forecast demo)"

FORECAST_TTL = int(os.environ.get("AQI_CACHE_TTL", "600"))     # live conditions: 10 min
ZONES_TTL = int(os.environ.get("AQI_ZONES_TTL", "86400"))      # OSM places: 1 day
ZONES_FALLBACK_TTL = 300                                       # retry Overpass soon after a miss

HORIZONS = (0, 6, 12, 18, 24)
GRID_COLS, GRID_ROWS = 16, 13        # must match the frontend heatmap grid
SPAN = 0.18                          # ~20 km visible box, same as the frontend mock

# CAMS-global (Open-Meteo's source) resolves to roughly 0.4 deg, so probing only the
# 0.18 deg visible box returns a single cell and a perfectly flat heatmap. Probing a
# metro-scale box instead captures the real regional gradient, which is then
# interpolated down onto the visible grid.
SAMPLE_SPAN = float(os.environ.get("AQI_SAMPLE_SPAN", "0.9"))
SAMPLE_COLS = SAMPLE_ROWS = 7

CITIES = [
    {"id": "delhi", "name": "New Delhi", "country": "India", "center": [28.6139, 77.209], "zoom": 11},
    {"id": "los-angeles", "name": "Los Angeles", "country": "USA", "center": [34.0522, -118.2437], "zoom": 11},
    {"id": "beijing", "name": "Beijing", "country": "China", "center": [39.9042, 116.4074], "zoom": 11},
    {"id": "london", "name": "London", "country": "UK", "center": [51.5074, -0.1278], "zoom": 11},
    {"id": "mexico-city", "name": "Mexico City", "country": "Mexico", "center": [19.4326, -99.1332], "zoom": 11},
    {"id": "jakarta", "name": "Jakarta", "country": "Indonesia", "center": [-6.2088, 106.8456], "zoom": 11},
]
CITY_BY_ID = {c["id"]: c for c in CITIES}

app = Flask(__name__)
CORS(app)
app.logger.setLevel(os.environ.get("AQI_LOG_LEVEL", "INFO"))


# --------------------------------------------------------------------------------------
# Tiny TTL cache
# --------------------------------------------------------------------------------------

_cache: Dict[str, Tuple[float, Any]] = {}
_cache_lock = threading.Lock()


def cached(key: str, ttl: int, producer):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = producer()
    with _cache_lock:
        _cache[key] = (now, value)
    return value


# --------------------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------------------

_models: Dict[int, Any] = {}
_model_lock = threading.Lock()


# A Git LFS pointer is a ~130 byte text file starting with this line. Cloning a repo
# without `git lfs pull` leaves these in place of the real pickles, and pickle.load
# then fails with the cryptic "invalid load key, 'v'".
LFS_POINTER_PREFIX = b"version https://git-lfs"


def is_lfs_pointer(path: str) -> bool:
    try:
        if os.path.getsize(path) > 4096:
            return False
        with open(path, "rb") as fh:
            return fh.read(len(LFS_POINTER_PREFIX)) == LFS_POINTER_PREFIX
    except OSError:
        return False


def download_model(horizon: int, dest: str) -> None:
    """Stream models/model_<h>.pkl from AQI_MODEL_BASE_URL into MODEL_DIR."""
    url = f"{MODEL_BASE_URL}/model_{horizon}.pkl"
    tmp = f"{dest}.part"
    try:
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        app.logger.info("downloading %s", url)
        started = time.time()
        with requests.get(url, stream=True, timeout=600) as res:
            res.raise_for_status()
            with open(tmp, "wb") as fh:
                for chunk in res.iter_content(chunk_size=1 << 20):
                    fh.write(chunk)
        os.replace(tmp, dest)  # only becomes visible once complete
        app.logger.info("downloaded model_%s.pkl (%.0f MB) in %.0fs", horizon,
                        os.path.getsize(dest) / 1048576, time.time() - started)
    except Exception as exc:
        app.logger.warning("could not download %s: %s", url, exc)
        if os.path.exists(tmp):
            os.remove(tmp)


def get_model(horizon: int):
    """Lazily unpickle models/model_<h>.pkl. Returns None if unavailable."""
    if not USE_MODELS or horizon == 0:
        return None
    with _model_lock:
        if horizon in _models:
            return _models[horizon]
        path = os.path.join(MODEL_DIR, f"model_{horizon}.pkl")

        # An LFS pointer is worse than a missing file: it exists, so a plain
        # existence check would skip the download and pickle would fail instead.
        pointer = os.path.exists(path) and is_lfs_pointer(path)
        if pointer:
            app.logger.warning(
                "%s is a Git LFS pointer, not the model itself — the checkout never ran "
                "`git lfs pull`. Set AQI_MODEL_BASE_URL to fetch it over HTTP, bake the "
                "real files into the image, or enable LFS in the build.", path)

        if (pointer or not os.path.exists(path)) and MODEL_BASE_URL:
            download_model(horizon, path)  # os.replace overwrites the pointer

        model = None
        try:
            with open(path, "rb") as fh:
                model = pickle.load(fh)
            app.logger.info("loaded %s", path)
        except Exception as exc:  # missing file, bad pickle, sklearn mismatch
            app.logger.warning("could not load %s: %s", path, exc)
        _models[horizon] = model
        return model


def features_from_pollutants(p: Dict[str, float]) -> Dict[str, float]:
    """
    Map Open-Meteo pollutant concentrations onto the CPCB feature names the
    models were trained on.

    Open-Meteo reports everything in ug/m3; CPCB reports CO in mg/m3. NO, NOx and
    the BTX group are not published by Open-Meteo, so they are estimated from NO2
    using typical urban traffic ratios — flagged here because they are estimates,
    not measurements.
    """
    no2 = max(0.0, float(p.get("nitrogen_dioxide") or 0.0))
    no = 0.40 * no2
    return {
        "PM2.5": max(0.0, float(p.get("pm2_5") or 0.0)),
        "PM10": max(0.0, float(p.get("pm10") or 0.0)),
        "NO": no,
        "NO2": no2,
        "NOx": no + no2,
        "NH3": max(0.0, float(p.get("ammonia") or 0.0)),
        "CO": max(0.0, float(p.get("carbon_monoxide") or 0.0)) / 1000.0,  # ug/m3 -> mg/m3
        "SO2": max(0.0, float(p.get("sulphur_dioxide") or 0.0)),
        "O3": max(0.0, float(p.get("ozone") or 0.0)),
        "Benzene": min(20.0, 0.020 * no2),
        "Toluene": min(60.0, 0.060 * no2),
        "Xylene": min(20.0, 0.012 * no2),
    }


def predict_horizon(horizon: int, feats: Dict[str, float]) -> Optional[Tuple[float, float]]:
    """Predict AQI at +horizon hours. Returns (mean, per-tree std) or None."""
    model = get_model(horizon)
    if model is None:
        return None
    try:
        cols = list(getattr(model, "feature_names_in_", list(feats.keys())))
        X = pd.DataFrame([[feats.get(c, 0.0) for c in cols]], columns=cols)
        mean = float(model.predict(X)[0])
        std = 0.0
        estimators = getattr(model, "estimators_", None)
        if estimators:
            # A sample of trees estimates the spread closely enough and keeps the
            # 1000-tree forests responsive.
            sample = estimators if len(estimators) <= TREE_SAMPLE else \
                list(np.random.default_rng(0).choice(np.array(estimators, dtype=object),
                                                     TREE_SAMPLE, replace=False))
            trees = np.array([float(t.predict(X.values)[0]) for t in sample])
            std = float(trees.std())
        return mean, std
    except Exception as exc:
        app.logger.warning("prediction failed for +%sh: %s", horizon, exc)
        return None


# --------------------------------------------------------------------------------------
# Live data fetching
# --------------------------------------------------------------------------------------

AQ_VARS = [
    "pm10", "pm2_5", "carbon_monoxide", "nitrogen_dioxide",
    "sulphur_dioxide", "ozone", "ammonia", "us_aqi",
]


def sample_points(center: Tuple[float, float]) -> List[Tuple[float, float]]:
    lat0, lng0 = center
    pts = []
    for r in range(SAMPLE_ROWS):
        for c in range(SAMPLE_COLS):
            lat = lat0 - SAMPLE_SPAN / 2 + SAMPLE_SPAN * r / (SAMPLE_ROWS - 1)
            lng = lng0 - SAMPLE_SPAN / 2 + SAMPLE_SPAN * c / (SAMPLE_COLS - 1)
            pts.append((lat, lng))
    return pts


def _hour_index(times: List[str]) -> int:
    """Index of the hour closest to now (UTC) in an Open-Meteo hourly time array."""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    best, best_delta = 0, None
    for i, t in enumerate(times):
        try:
            dt = datetime.fromisoformat(t)
        except ValueError:
            continue
        delta = abs((dt - now).total_seconds())
        if best_delta is None or delta < best_delta:
            best, best_delta = i, delta
    return best


def fetch_air_quality(points: List[Tuple[float, float]]) -> List[Dict[str, Any]]:
    """One batched Open-Meteo call for every sample point. Returns per-point dicts."""
    params = {
        "latitude": ",".join(f"{p[0]:.4f}" for p in points),
        "longitude": ",".join(f"{p[1]:.4f}" for p in points),
        "hourly": ",".join(AQ_VARS),
        "forecast_days": 2,
        "timezone": "UTC",
    }
    res = requests.get(AQ_URL, params=params, timeout=25)
    res.raise_for_status()
    payload = res.json()
    if isinstance(payload, dict):
        payload = [payload]

    out: List[Dict[str, Any]] = []
    for (lat, lng), item in zip(points, payload):
        hourly = item.get("hourly", {})
        times = hourly.get("time", [])
        idx = _hour_index(times)
        now_vals = {v: _at(hourly.get(v), idx) for v in AQ_VARS}
        # Open-Meteo's own +h AQI, used as a sanity anchor / model fallback.
        ahead = {h: _at(hourly.get("us_aqi"), idx + h) for h in HORIZONS if h}
        out.append({"lat": lat, "lng": lng, "now": now_vals, "openmeteo_ahead": ahead})
    return out


def _at(series: Optional[List[Any]], idx: int) -> Optional[float]:
    if not series or idx < 0 or idx >= len(series):
        return None
    val = series[idx]
    return None if val is None else float(val)


def fetch_weather(center: Tuple[float, float]) -> Dict[str, float]:
    params = {
        "latitude": center[0],
        "longitude": center[1],
        "current": "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m",
        "timezone": "UTC",
    }
    res = requests.get(WX_URL, params=params, timeout=15)
    res.raise_for_status()
    cur = res.json().get("current", {})
    return {
        "temperature": round(float(cur.get("temperature_2m") or 20.0)),
        "humidity": round(float(cur.get("relative_humidity_2m") or 50.0)),
        "windSpeed": round(float(cur.get("wind_speed_10m") or 5.0), 1),
        # Meteorological wind direction is where wind comes FROM; the map draws
        # where pollution is heading, so flip it by 180 degrees.
        "windDirection": int((float(cur.get("wind_direction_10m") or 0.0) + 180) % 360),
    }


# --------------------------------------------------------------------------------------
# Risk zones (OpenStreetMap / Overpass, with fallback)
# --------------------------------------------------------------------------------------

# Ask Overpass for named places only, with a per-category cap so schools can't use up
# the whole result budget before stadiums and worksites are returned.
OVERPASS_QUERY = """
[out:json][timeout:25];
(node["amenity"="school"]["name"](%(s)f,%(w)f,%(n)f,%(e)f);
 way["amenity"="school"]["name"](%(s)f,%(w)f,%(n)f,%(e)f););
out tags center 40;
(node["leisure"="stadium"]["name"](%(s)f,%(w)f,%(n)f,%(e)f);
 way["leisure"="stadium"]["name"](%(s)f,%(w)f,%(n)f,%(e)f);
 way["leisure"="pitch"]["name"](%(s)f,%(w)f,%(n)f,%(e)f););
out tags center 25;
(way["landuse"="construction"]["name"](%(s)f,%(w)f,%(n)f,%(e)f);
 way["landuse"="industrial"]["name"](%(s)f,%(w)f,%(n)f,%(e)f););
out tags center 40;
"""

FALLBACK_ZONES = {
    "school": ["Central High School", "Riverside Elementary", "Northgate Academy", "Lincoln Primary"],
    "stadium": ["Metro Sports Arena", "Eastside Football Ground"],
    "worker_zone": ["Dockside Construction", "Riverbank Industrial Park", "Highway 4 Roadworks"],
}


def classify_osm(tags: Dict[str, str]) -> Optional[str]:
    if tags.get("amenity") == "school":
        return "school"
    if tags.get("leisure") in ("stadium", "pitch"):
        return "stadium"
    if tags.get("landuse") in ("construction", "industrial"):
        return "worker_zone"
    return None


def fetch_osm_zones(city: Dict[str, Any]) -> List[Dict[str, Any]]:
    lat, lng = city["center"]
    bbox = {"s": lat - SPAN / 2, "w": lng - SPAN / 2, "n": lat + SPAN / 2, "e": lng + SPAN / 2}
    body = (OVERPASS_QUERY % bbox).encode("utf-8")
    wanted = {"school": 4, "stadium": 2, "worker_zone": 3}
    last_error: Optional[Exception] = None

    for url in OVERPASS_URLS:
        try:
            res = requests.post(
                url.strip(),
                data=body,
                headers={"Content-Type": "text/plain; charset=utf-8", "User-Agent": USER_AGENT},
                timeout=25,
            )
            res.raise_for_status()
            elements = res.json().get("elements", [])

            picked: Dict[str, List[Dict[str, Any]]] = {k: [] for k in wanted}
            for el in elements:
                tags = el.get("tags", {}) or {}
                kind = classify_osm(tags)
                name = tags.get("name")
                if not kind or not name or len(picked[kind]) >= wanted[kind]:
                    continue
                center = el.get("center") or {"lat": el.get("lat"), "lon": el.get("lon")}
                if center.get("lat") is None or center.get("lon") is None:
                    continue
                picked[kind].append({
                    "id": f"{kind}-{len(picked[kind])}",
                    "name": name,
                    "type": kind,
                    "lat": float(center["lat"]),
                    "lng": float(center["lon"]),
                })

            zones = [z for kind in wanted for z in picked[kind]]
            if zones:
                return zones
            # A throttled mirror can answer 200 with nothing; try the next one.
            last_error = RuntimeError(f"{url.strip()} returned no named places")
        except Exception as exc:
            app.logger.info("Overpass mirror %s unavailable: %s", url.strip(), exc)
            last_error = exc

    raise RuntimeError(f"all Overpass mirrors failed: {last_error}")


def synthetic_zones(city: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Deterministic placeholder layout when OSM is unavailable."""
    lat, lng = city["center"]
    rng = np.random.default_rng(abs(hash(city["id"])) % (2**32))
    zones = []
    for kind, names in FALLBACK_ZONES.items():
        for i, name in enumerate(names):
            zones.append({
                "id": f"{kind}-{i}",
                "name": name,
                "type": kind,
                "lat": lat + float(rng.uniform(-0.46, 0.46)) * SPAN,
                "lng": lng + float(rng.uniform(-0.46, 0.46)) * SPAN,
            })
    return zones


_zone_refreshes: set = set()


def _refresh_zones_async(city: Dict[str, Any]) -> None:
    """Fetch OSM places off the request path; the next poll picks them up."""
    key = city["id"]
    with _cache_lock:
        if key in _zone_refreshes:
            return
        _zone_refreshes.add(key)

    def run():
        try:
            zones = fetch_osm_zones(city)
            with _cache_lock:
                _cache[f"zones:{key}"] = (time.time(), (zones, True))
                # Drop the cached forecast so the dashboard's next poll (SWR refreshes
                # every 60s) shows the real places instead of the placeholders.
                _cache.pop(f"forecast:{key}", None)
            app.logger.info("refreshed %d OSM zones for %s", len(zones), key)
        except Exception as exc:
            app.logger.warning("Overpass lookup failed for %s, keeping placeholders: %s",
                               key, exc)
            with _cache_lock:
                # Remember the miss so we don't hammer Overpass on every request.
                hit = _cache.get(f"zones:{key}")
                if hit:
                    _cache[f"zones:{key}"] = (time.time(), (hit[1][0], False))
        finally:
            with _cache_lock:
                _zone_refreshes.discard(key)

    threading.Thread(target=run, daemon=True).start()


def get_zones(city: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Never block the dashboard on Overpass: answer from cache (placeholders on the
    very first call) and refresh in the background. Real OSM places are kept for a
    day; a fallback is retried after a few minutes.
    """
    key = f"zones:{city['id']}"
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)

    if hit:
        ts, (zones, is_real) = hit
        if now - ts >= (ZONES_TTL if is_real else ZONES_FALLBACK_TTL) and USE_OVERPASS:
            _refresh_zones_async(city)
        return zones

    zones = synthetic_zones(city)
    with _cache_lock:
        _cache[key] = (now, (zones, False))
    if USE_OVERPASS:
        _refresh_zones_async(city)
    return zones


def fetch_waqi_stations(city: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Real monitoring stations inside the visible box (requires WAQI_TOKEN)."""
    if not WAQI_TOKEN:
        return []
    lat, lng = city["center"]
    latlng = f"{lat - SPAN / 2},{lng - SPAN / 2},{lat + SPAN / 2},{lng + SPAN / 2}"
    try:
        res = requests.get(
            "https://api.waqi.info/map/bounds/",
            params={"latlng": latlng, "token": WAQI_TOKEN},
            headers={"User-Agent": USER_AGENT},
            timeout=15,
        )
        res.raise_for_status()
        payload = res.json()
        if payload.get("status") != "ok":
            raise RuntimeError(payload.get("data"))
        stations = []
        for st in payload.get("data", []):
            try:
                aqi = float(st.get("aqi"))
            except (TypeError, ValueError):
                continue  # stations report "-" when offline
            stations.append({
                "lat": float(st["lat"]),
                "lng": float(st["lon"]),
                "aqi": aqi,
                "pm25": None,
                "name": (st.get("station") or {}).get("name"),
            })
        return stations
    except Exception as exc:
        app.logger.warning("WAQI station lookup failed for %s: %s", city["id"], exc)
        return []


# --------------------------------------------------------------------------------------
# Spatial interpolation
# --------------------------------------------------------------------------------------

def idw(lat: float, lng: float, samples: List[Dict[str, Any]], key: str, default: float) -> float:
    """Inverse-distance-weighted value from the live sample probes."""
    num = den = 0.0
    for s in samples:
        val = s.get(key)
        if val is None:
            continue
        d2 = (lat - s["lat"]) ** 2 + (lng - s["lng"]) ** 2 + 1e-7
        w = 1.0 / (d2 ** 1.15)
        num += w * val
        den += w
    return num / den if den else default


# --------------------------------------------------------------------------------------
# Forecast assembly
# --------------------------------------------------------------------------------------

def build_forecast(city: Dict[str, Any]) -> Dict[str, Any]:
    center = tuple(city["center"])

    probes = fetch_air_quality(sample_points(list(center)))  # type: ignore[arg-type]
    weather = fetch_weather(center)  # type: ignore[arg-type]

    # Flatten probes into IDW-friendly records.
    samples = []
    for p in probes:
        n = p["now"]
        pm25 = n.get("pm2_5")
        aqi = n.get("us_aqi")
        if aqi is None and pm25 is not None:
            aqi = pm25_to_aqi(pm25)
        samples.append({
            "lat": p["lat"], "lng": p["lng"],
            "aqi": aqi, "pm25": pm25,
            **{k: n.get(k) for k in AQ_VARS},
        })

    # Real monitoring stations, when a WAQI token is configured, sit inside the visible
    # box and so dominate the interpolation locally — genuine hyperlocal detail.
    stations = fetch_waqi_stations(city)
    samples.extend(stations)

    # The probe box is metro-scale, so the city figure is the field value at the centre,
    # not a flat average over the whole sampled region.
    city_aqi_now = idw(center[0], center[1], samples, "aqi", 60.0)

    # Pollutant mix at the city centre -> model features -> horizon predictions.
    mix = {v: idw(center[0], center[1], samples, v, 0.0) for v in AQ_VARS}
    feats = features_from_pollutants(mix)

    horizon_aqi: Dict[int, float] = {0: city_aqi_now}
    horizon_std: Dict[int, float] = {0: 0.0}
    model_used: Dict[int, str] = {0: "observed"}

    for h in HORIZONS[1:]:
        pred = predict_horizon(h, feats)
        if pred is not None:
            horizon_aqi[h], horizon_std[h] = pred
            model_used[h] = f"model_{h}.pkl"
        else:
            fallback = _mean([p["openmeteo_ahead"].get(h) for p in probes])
            horizon_aqi[h] = fallback if fallback is not None else city_aqi_now
            horizon_std[h] = 6.0 + 1.4 * h
            model_used[h] = "open-meteo"

    # Wind drift: how far the plume travels per hour, in degrees.
    rad = math.radians(weather["windDirection"])
    drift_lat = math.cos(rad) * weather["windSpeed"] * 0.00026
    drift_lng = math.sin(rad) * weather["windSpeed"] * 0.00026

    grid_by_horizon: Dict[int, List[Dict[str, Any]]] = {}
    lat0, lng0 = center
    for h in HORIZONS:
        # Scale the observed field by the predicted city-wide change, and sample it
        # upwind so the pattern visibly drifts downwind over the horizon.
        scale = horizon_aqi[h] / city_aqi_now if city_aqi_now > 0 else 1.0
        points = []
        for r in range(GRID_ROWS):
            for c in range(GRID_COLS):
                lat = lat0 - SPAN / 2 + SPAN * r / (GRID_ROWS - 1)
                lng = lng0 - SPAN / 2 + SPAN * c / (GRID_COLS - 1)
                src_lat = lat - drift_lat * h
                src_lng = lng - drift_lng * h
                aqi = idw(src_lat, src_lng, samples, "aqi", city_aqi_now) * scale
                pm25 = idw(src_lat, src_lng, samples, "pm25", aqi * 0.55) * scale
                points.append({
                    "lat": lat,
                    "lng": lng,
                    "aqi": max(1, int(round(aqi))),
                    "pm25": round(pm25, 1),
                })
        grid_by_horizon[h] = points

    # Sparse wind arrows, matching the frontend's stride.
    wind_vectors = []
    for r in range(1, GRID_ROWS, 4):
        for c in range(1, GRID_COLS, 4):
            wind_vectors.append({
                "lat": lat0 - SPAN / 2 + SPAN * r / (GRID_ROWS - 1),
                "lng": lng0 - SPAN / 2 + SPAN * c / (GRID_COLS - 1),
                "direction": weather["windDirection"],
                "speed": weather["windSpeed"],
            })

    # Risk zones: scale the city-level trajectory by each zone's local AQI.
    hours = list(range(0, 25, 2))
    base_x = list(HORIZONS)
    base_y = [horizon_aqi[h] for h in base_x]
    base_s = [horizon_std[h] for h in base_x]

    risk_zones = []
    for z in get_zones(city):
        current = idw(z["lat"], z["lng"], samples, "aqi", city_aqi_now)
        ratio = current / city_aqi_now if city_aqi_now > 0 else 1.0
        series = []
        for hour in hours:
            aqi = float(np.interp(hour, base_x, base_y)) * ratio
            spread = float(np.interp(hour, base_x, base_s))
            spread = max(spread, 6.0 + hour * 1.1)  # never claim more certainty than we have
            aqi_i = max(1, int(round(aqi)))
            series.append({
                "hour": hour,
                "aqi": aqi_i,
                "low": max(1, int(round(aqi_i - spread))),
                "high": int(round(aqi_i + spread)),
            })
        risk_zones.append({
            "id": z["id"],
            "name": z["name"],
            "type": z["type"],
            "lat": z["lat"],
            "lng": z["lng"],
            "currentAQI": max(1, int(round(current))),
            "forecast": series,
        })

    alerts = []
    for zone in risk_zones:
        point = next((p for p in zone["forecast"] if p["hour"] == 12), zone["forecast"][-1])
        predicted = point["aqi"]
        if predicted - zone["currentAQI"] > 8 or predicted > 120:
            alerts.append({
                "zoneId": zone["id"],
                "zoneName": zone["name"],
                "type": zone["type"],
                "currentAQI": zone["currentAQI"],
                "predictedAQI": predicted,
                "horizonHours": 12,
                "severity": severity_for_aqi(predicted),
            })
    alerts.sort(key=lambda a: a["predictedAQI"], reverse=True)

    conditions = {
        "aqi": int(round(city_aqi_now)),
        "pm25": round(idw(center[0], center[1], samples, "pm2_5", city_aqi_now * 0.55), 1),
        "windSpeed": weather["windSpeed"],
        "windDirection": weather["windDirection"],
        "temperature": weather["temperature"],
        "humidity": weather["humidity"],
    }

    return {
        "cityId": city["id"],
        # Lets the dashboard label and centre a geolocated point, which has no
        # entry in the frontend's CITIES list.
        "location": {
            "id": city["id"],
            "name": city["name"],
            "country": city.get("country", ""),
            "center": list(city["center"]),
            "zoom": city.get("zoom", 11),
            "source": city.get("source", "preset"),
        },
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "conditions": conditions,
        "gridByHorizon": grid_by_horizon,
        "windVectors": wind_vectors,
        "riskZones": risk_zones,
        "alerts": alerts,
        "meta": {
            "source": "open-meteo" + (f" + waqi ({len(stations)} stations)" if stations else ""),
            "stations": [
                {"name": st.get("name"), "aqi": st["aqi"], "lat": st["lat"], "lng": st["lng"]}
                for st in stations
            ],
            "predictedAqiByHorizon": {str(h): round(v, 1) for h, v in horizon_aqi.items()},
            "modelByHorizon": {str(h): m for h, m in model_used.items()},
            "pollutants": {k: round(v, 2) for k, v in feats.items()},
        },
    }


def _mean(values: Iterable[Optional[float]]) -> Optional[float]:
    vals = [float(v) for v in values if v is not None]
    return float(np.mean(vals)) if vals else None


PM25_BREAKPOINTS = [
    (0.0, 12.0, 0, 50), (12.1, 35.4, 51, 100), (35.5, 55.4, 101, 150),
    (55.5, 150.4, 151, 200), (150.5, 250.4, 201, 300), (250.5, 500.4, 301, 500),
]


def pm25_to_aqi(pm25: float) -> float:
    """US EPA piecewise-linear PM2.5 -> AQI, used only if us_aqi is missing."""
    for lo, hi, alo, ahi in PM25_BREAKPOINTS:
        if lo <= pm25 <= hi:
            return (ahi - alo) / (hi - lo) * (pm25 - lo) + alo
    return 500.0


def severity_for_aqi(aqi: float) -> str:
    if aqi <= 50:
        return "Low"
    if aqi <= 100:
        return "Moderate"
    if aqi <= 150:
        return "High"
    return "Severe" if aqi > 200 else "High"


def aqi_category(aqi: float) -> str:
    if aqi <= 50:
        return "Good"
    if aqi <= 100:
        return "Moderate"
    if aqi <= 150:
        return "Unhealthy for Sensitive Groups"
    if aqi <= 200:
        return "Unhealthy"
    return "Very Unhealthy"


# --------------------------------------------------------------------------------------
# Geolocation
# --------------------------------------------------------------------------------------

def reverse_geocode(lat: float, lng: float) -> Dict[str, str]:
    """Name a coordinate. Both providers are keyless; a failure is not fatal."""
    try:
        res = requests.get(
            "https://api.bigdatacloud.net/data/reverse-geocode-client",
            params={"latitude": lat, "longitude": lng, "localityLanguage": "en"},
            headers={"User-Agent": USER_AGENT},
            timeout=10,
        )
        res.raise_for_status()
        d = res.json()
        name = d.get("locality") or d.get("city") or d.get("principalSubdivision")
        if name:
            return {"name": name, "country": d.get("countryName") or ""}
    except Exception as exc:
        app.logger.info("BigDataCloud reverse geocode failed: %s", exc)

    try:
        res = requests.get(
            "https://nominatim.openstreetmap.org/reverse",
            params={"format": "json", "lat": lat, "lon": lng, "zoom": 12},
            headers={"User-Agent": USER_AGENT},
            timeout=10,
        )
        res.raise_for_status()
        a = res.json().get("address", {})
        name = (a.get("suburb") or a.get("city") or a.get("town")
                or a.get("village") or a.get("county") or a.get("state"))
        if name:
            return {"name": name, "country": a.get("country") or ""}
    except Exception as exc:
        app.logger.info("Nominatim reverse geocode failed: %s", exc)

    return {"name": f"{lat:.3f}, {lng:.3f}", "country": ""}


def search_places(query: str, count: int = 8) -> List[Dict[str, Any]]:
    """Forward geocoding for the dashboard's search box (Open-Meteo, keyless)."""
    res = requests.get(
        "https://geocoding-api.open-meteo.com/v1/search",
        params={"name": query, "count": count, "language": "en", "format": "json"},
        headers={"User-Agent": USER_AGENT},
        timeout=10,
    )
    res.raise_for_status()
    out = []
    for r in res.json().get("results", []):
        lat, lng = float(r["latitude"]), float(r["longitude"])
        # admin1 is what separates Springfield, Missouri from Springfield, Illinois.
        region = r.get("admin1") or ""
        country = r.get("country") or ""
        out.append({
            "id": f"geo:{round(lat, 2)},{round(lng, 2)}",
            "name": r.get("name") or query,
            "region": region,
            "country": country,
            "label": ", ".join(x for x in [r.get("name"), region, country] if x),
            "center": [lat, lng],
            "zoom": 12,
            "population": r.get("population"),
            "source": "search",
        })
    return out


def location_from_coords(lat: float, lng: float, label: Optional[str] = None) -> Dict[str, Any]:
    """
    Build a city-shaped dict for an arbitrary point so the rest of the pipeline
    (probes, zones, forecast) needs no special case. Coordinates are rounded to
    ~1 km so nearby requests share a cache entry and one set of OSM zones.
    """
    lat = round(float(lat), 2)
    lng = round(float(lng), 2)
    named = {"name": label, "country": ""} if label else cached(
        f"revgeo:{lat},{lng}", ZONES_TTL, lambda: reverse_geocode(lat, lng)
    )
    return {
        "id": f"geo:{lat},{lng}",
        "name": named["name"],
        "country": named.get("country", ""),
        "center": [lat, lng],
        "zoom": 12,
        "source": "geolocation",
    }


def parse_coords(args) -> Optional[Tuple[float, float]]:
    """Read lat/lng (or lat/lon) query params. Raises ValueError when malformed."""
    raw_lat = args.get("lat")
    raw_lng = args.get("lng") or args.get("lon")
    if raw_lat is None or raw_lng is None:
        return None
    lat, lng = float(raw_lat), float(raw_lng)
    if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
        raise ValueError(f"coordinates out of range: {lat}, {lng}")
    return lat, lng


# --------------------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------------------

def _model_file_state(path: str) -> str:
    if not os.path.exists(path):
        return "missing"
    if is_lfs_pointer(path):
        return "lfs-pointer (run `git lfs pull` or set AQI_MODEL_BASE_URL)"
    return f"ok ({os.path.getsize(path) // 1048576}MB)"


@app.get("/api/health")
def health():
    return jsonify({
        "status": "ok",
        "chat": {
            # Whether an LLM will answer, without ever echoing the key itself.
            "provider": "groq" if os.environ.get("GROQ_API_KEY") else "local-fallback",
            "keyConfigured": bool(os.environ.get("GROQ_API_KEY")
                                  or os.environ.get("OPENAI_API_KEY")),
            "model": CHAT_MODEL,
            "dotenvAvailable": DOTENV_AVAILABLE,
        },
        "modelsEnabled": USE_MODELS,
        "modelsLoaded": sorted(h for h, m in _models.items() if m is not None),
        "modelDir": MODEL_DIR,
        "modelFiles": {
            str(h): _model_file_state(os.path.join(MODEL_DIR, f"model_{h}.pkl"))
            for h in HORIZONS[1:]
        },
        "overpassEnabled": USE_OVERPASS,
        "cachedKeys": len(_cache),
    })


@app.get("/api/cities")
def cities():
    return jsonify(CITIES)


@app.get("/api/forecast")
def forecast():
    """
    Either ?city=<preset id> or ?lat=&lng= for the browser's geolocation.
    Coordinates win when both are present.
    """
    try:
        coords = parse_coords(request.args)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    if coords:
        city = location_from_coords(coords[0], coords[1], request.args.get("name"))
    else:
        city_id = request.args.get("city", "delhi")
        if city_id not in CITY_BY_ID:
            return jsonify({"error": f"unknown city '{city_id}'",
                            "cities": list(CITY_BY_ID)}), 400
        city = CITY_BY_ID[city_id]

    try:
        data = cached(f"forecast:{city['id']}", FORECAST_TTL, lambda: build_forecast(city))
    except requests.RequestException as exc:
        return jsonify({"error": "upstream air-quality API unavailable", "detail": str(exc)}), 502
    return jsonify(data)


@app.get("/api/search")
def search():
    """?q=<place name> -> ranked matches the UI can turn into a forecast request."""
    query = (request.args.get("q") or "").strip()
    if len(query) < 2:
        return jsonify([])
    try:
        count = max(1, min(int(request.args.get("count", 8)), 20))
    except ValueError:
        count = 8
    try:
        results = cached(f"search:{query.lower()}:{count}", ZONES_TTL,
                         lambda: search_places(query, count))
    except requests.RequestException as exc:
        return jsonify({"error": "geocoding service unavailable", "detail": str(exc)}), 502
    return jsonify(results)


@app.get("/api/geocode")
def geocode():
    """Name a coordinate (?lat=&lng=), so the UI can label 'Your location'."""
    try:
        coords = parse_coords(request.args)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if not coords:
        return jsonify({"error": "lat and lng are required"}), 400
    return jsonify(location_from_coords(coords[0], coords[1]))


# ---------------------------------- chat ----------------------------------------------

def build_system_prompt(ctx: Dict[str, Any]) -> str:
    lines = [
        "You are AeroCast Assistant, an expert air-quality guide embedded in a predictive "
        "pollution-movement dashboard.",
        "Answer questions about air quality, AQI, PM2.5/PM10, pollution movement, wind-driven "
        "spillover, health precautions, and how to read the dashboard.",
        "Be concise and practical. When giving health advice, note you are not a substitute "
        "for medical guidance.",
        "The chat bubble renders plain text, so write plain text only: no markdown syntax, no "
        "**bold**, no headings, no backticks. Use short paragraphs and '-' for bullets.",
        "Use the live dashboard context below when relevant. If asked about data you don't have, "
        "say so plainly.",
    ]
    if ctx.get("city"):
        lines.append(f"\nCurrently viewing: {ctx['city']}.")
    horizon = ctx.get("horizon")
    if isinstance(horizon, (int, float)):
        lines.append("Forecast horizon: now (live)." if horizon == 0
                     else f"Forecast horizon: +{int(horizon)}h prediction.")
    c = ctx.get("conditions")
    if c:
        lines.append(
            f"\nCurrent conditions — AQI {c.get('aqi')} ({c.get('category')}), "
            f"PM2.5 {c.get('pm25')} ug/m3, wind {c.get('windSpeed')} km/h toward "
            f"{c.get('windDirection')} deg, temp {c.get('temperature')} C, "
            f"humidity {c.get('humidity')}%."
        )
    zones = ctx.get("riskZones") or []
    if zones:
        lines.append("\nRisk zones (current AQI):")
        for z in zones:
            lines.append(f"- {z.get('name')} ({z.get('type')}): {z.get('currentAQI')}")
    alerts = ctx.get("alerts") or []
    if alerts:
        lines.append("\nActive spillover alerts:")
        for a in alerts:
            lines.append(f"- [{a.get('severity')}] {a.get('zoneName')}")
    return "\n".join(lines)


def extract_text(message: Dict[str, Any]) -> str:
    """UIMessage -> plain text (AI SDK sends content as a list of parts)."""
    parts = message.get("parts")
    if isinstance(parts, list):
        return " ".join(p.get("text", "") for p in parts if p.get("type") == "text").strip()
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    return ""


_groq_client = None
_groq_lock = threading.Lock()


def get_groq_client():
    """Lazily build the GroqCloud client. Returns None when no key is configured."""
    global _groq_client
    api_key = os.environ.get("GROQ_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return None
    with _groq_lock:
        if _groq_client is None:
            from groq import Groq  # imported lazily so the server runs without the SDK

            _groq_client = Groq(api_key=api_key, base_url=CHAT_BASE_URL, timeout=90.0)
        return _groq_client


def llm_stream(system: str, history: List[Dict[str, str]]) -> Iterable[str]:
    """
    Stream the answer from GroqCloud (default model: openai/gpt-oss-120b) using the
    official groq client. Returns None when no key is configured, which makes
    /api/chat fall back to grounded local answers.
    """
    client = get_groq_client()
    if client is None:
        return None  # type: ignore[return-value]

    kwargs: Dict[str, Any] = {
        "model": CHAT_MODEL,
        "messages": [{"role": "system", "content": system}] + history,
        "stream": True,
        "temperature": 0.3,
        "max_completion_tokens": CHAT_MAX_TOKENS,
    }
    if "gpt-oss" in CHAT_MODEL:
        # gpt-oss is a reasoning model: keep the thinking short and out of the
        # response stream so the chat bubble only ever shows the answer.
        kwargs["reasoning_effort"] = CHAT_REASONING_EFFORT
        kwargs["reasoning_format"] = "hidden"

    stream = client.chat.completions.create(**kwargs)  # raises on auth/quota errors

    def gen():
        for chunk in stream:
            if not chunk.choices:
                continue
            # `delta.reasoning` is the model's scratchpad — never forward it.
            text = chunk.choices[0].delta.content
            if text:
                yield text

    return gen()


def local_answer(question: str, ctx: Dict[str, Any]) -> str:
    """Grounded, rule-based reply used when no LLM key is configured."""
    q = question.lower()
    c = ctx.get("conditions") or {}
    aqi = c.get("aqi")
    city = ctx.get("city", "this area")
    cat = c.get("category") or (aqi_category(aqi) if aqi is not None else "unknown")

    if aqi is None:
        return ("I don't have live readings loaded right now. Refresh the dashboard and ask "
                "again and I'll read the current AQI, wind and risk zones for you.")

    head = f"{city} — AQI {aqi} ({cat}), PM2.5 {c.get('pm25')} µg/m³."

    if any(k in q for k in ("exercise", "run", "outside", "outdoor", "safe", "walk", "jog")):
        if aqi <= 50:
            body = "Air is clean. Outdoor exercise is fine for everyone."
        elif aqi <= 100:
            body = ("Acceptable for most people. If you're asthmatic or unusually sensitive, keep "
                    "hard efforts short and prefer routes away from traffic.")
        elif aqi <= 150:
            body = ("Sensitive groups — children, older adults, anyone with asthma or heart disease "
                    "— should cut back on strenuous outdoor effort. Everyone else can go, but keep "
                    "intensity moderate.")
        elif aqi <= 200:
            body = ("Move workouts indoors. Sensitive groups should avoid outdoor exertion; everyone "
                    "should shorten time outside.")
        else:
            body = "Avoid outdoor exertion entirely. Stay indoors with filtered air if you can."
        return f"{head}\n\n{body}\n\nThis is general guidance, not medical advice."

    if any(k in q for k in ("wind", "drift", "spillover", "moving", "direction", "12 hour", "next")):
        wd, ws = c.get("windDirection"), c.get("windSpeed")
        alerts = ctx.get("alerts") or []
        body = (f"Wind is carrying pollution toward {wd}° at {ws} km/h, so plumes advect roughly "
                f"{round((ws or 0) * 12)} km downwind over 12 hours. That's the drift the "
                "horizon slider animates.")
        if alerts:
            body += "\n\nZones flagged for spillover: " + ", ".join(
                a.get("zoneName", "?") for a in alerts[:4]) + "."
        return f"{head}\n\n{body}"

    if any(k in q for k in ("category", "mean", "scale", "sensitive", "what is aqi")):
        return (f"{head}\n\n- 0–50 Good\n- 51–100 Moderate\n- 101–150 Unhealthy for Sensitive "
                "Groups\n- 151–200 Unhealthy\n- 201+ Very Unhealthy\n\nSensitive groups start "
                f"feeling effects above 100; you're currently in {cat}.")

    zones = ctx.get("riskZones") or []
    zone_line = ""
    if zones:
        worst = max(zones, key=lambda z: z.get("currentAQI") or 0)
        zone_line = (f"\n\nHighest-exposure zone right now: {worst.get('name')} "
                     f"at AQI {worst.get('currentAQI')}.")
    return (f"{head}{zone_line}\n\nAsk me about outdoor safety, what the wind is doing, why a zone "
            "is flagged, or what the AQI categories mean.\n\n(No LLM key configured — set "
            "GROQ_API_KEY in backend/.env for full conversational answers.)")


def ui_message_stream(chunks: Iterable[str]) -> Iterable[str]:
    """Encode text chunks as an AI SDK UI message stream (SSE)."""
    def sse(obj: Dict[str, Any]) -> str:
        return f"data: {json.dumps(obj)}\n\n"

    text_id = "txt-0"
    yield sse({"type": "start"})
    yield sse({"type": "start-step"})
    yield sse({"type": "text-start", "id": text_id})
    try:
        for chunk in chunks:
            if chunk:
                yield sse({"type": "text-delta", "id": text_id, "delta": chunk})
    except Exception as exc:  # surface upstream failures inside the bubble
        yield sse({"type": "text-delta", "id": text_id, "delta": f"\n\n_Error: {exc}_"})
    yield sse({"type": "text-end", "id": text_id})
    yield sse({"type": "finish-step"})
    yield sse({"type": "finish"})
    yield "data: [DONE]\n\n"


def word_chunks(text: str) -> Iterable[str]:
    for word in text.split(" "):
        yield word + " "
        time.sleep(0.012)  # typewriter feel for the canned answers


@app.post("/api/chat")
def chat():
    body = request.get_json(silent=True) or {}
    ctx = body.get("context") or {}
    messages = body.get("messages") or []

    history = []
    for m in messages[-12:]:
        role = m.get("role")
        text = extract_text(m)
        if role in ("user", "assistant") and text:
            history.append({"role": role, "content": text})

    question = history[-1]["content"] if history and history[-1]["role"] == "user" else ""
    system = build_system_prompt(ctx)

    try:
        chunks = llm_stream(system, history)
    except Exception as exc:
        app.logger.warning("LLM call failed, falling back locally: %s", exc)
        chunks = None
    if chunks is None:
        chunks = word_chunks(local_answer(question, ctx))

    return Response(
        stream_with_context(ui_message_stream(chunks)),
        mimetype="text/event-stream",
        headers={
            "x-vercel-ai-ui-message-stream": "v1",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def warm_models() -> None:
    def run():
        started = time.time()
        for h in HORIZONS[1:]:
            get_model(h)
        app.logger.info("model warmup finished in %.1fs", time.time() - started)

    threading.Thread(target=run, daemon=True).start()


if USE_MODELS and WARM_MODELS:
    warm_models()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("FLASK_DEBUG") == "1", threaded=True)
