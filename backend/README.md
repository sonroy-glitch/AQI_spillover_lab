# AeroCast backend

Single-file Flask server (`app.py`) that serves the Next.js dashboard in `../frontend`
with **live** air-quality data and AQI predictions from the RandomForest models in
`../models`.

## Routes

| Route | Used by | Notes |
| --- | --- | --- |
| `GET /api/forecast?city=<id>&hours=24` | `components/pollution/dashboard.tsx` (SWR, 60s refresh) | Returns the exact `ForecastResponse` shape from `lib/pollution/types.ts`, plus `location` and a `meta` block |
| `GET /api/forecast?lat=&lng=` | the same component, after "My location" | Same response for an arbitrary point; `name=` overrides the reverse-geocoded label |
| `GET /api/geocode?lat=&lng=` | — | Names a coordinate without running a forecast |
| `GET /api/search?q=&count=8` | `components/pollution/city-search.tsx` | Place search (Open-Meteo forward geocoding) behind the header's search box |
| `POST /api/chat` | `components/pollution/chat-widget.tsx` (`@ai-sdk/react`) | Server-sent events in the AI SDK **UI message stream** format |
| `GET /api/cities` | — | Same six cities the frontend hardcodes in `lib/pollution/data.ts` |
| `GET /api/health` | — | Liveness, resident models, cache size, and a `chat` block reporting whether a Groq key was picked up (never the key itself) |

## Search and geolocation

The header's **search box** (`/api/search?q=`) does forward geocoding through
Open-Meteo, so any city on Earth can be loaded, not just the six presets. Results carry
`admin1`, which is what separates Springfield, Illinois from Springfield, Missouri, and
picking one refetches with that place's coordinates. The frontend debounces at 300ms and
supports arrow-key/Enter selection.

The top bar's **My location** button calls `navigator.geolocation` and refetches with
`?lat=&lng=` instead of `?city=`. The backend treats the point exactly like a preset:
it probes the same metro-scale box, pulls OSM risk zones around it, and runs the same
models — then reverse-geocodes the coordinate so the UI has a name to show
(`location.name`, e.g. "Pune, India").

- Reverse geocoding is keyless: **BigDataCloud** first, **Nominatim** as backup, and a
  `"18.520, 73.857"` label if both fail.
- Coordinates are rounded to 2 decimals (~1 km) for the cache key, so repeated
  requests from the same neighbourhood share one forecast and one set of zones.
- Browsers only expose geolocation in a **secure context**: https, or localhost in
  development. Served over plain http on a LAN address the button reports that
  rather than hanging.
- Denials are shown inline in the header; the previous location stays on screen.

## Data sources (no API key required)

- **Open-Meteo Air Quality** — PM2.5, PM10, NO₂, SO₂, O₃, CO, NH₃, US AQI.
- **Open-Meteo Forecast** — wind speed/direction, temperature, humidity.
  Wind direction is flipped 180° because the map draws where pollution is *heading*.
- **OpenStreetMap / Overpass** — real schools, stadiums and industrial/construction
  sites inside the map box become the risk zones. This never blocks a response: the
  first request for a city answers immediately with placeholder zones and fetches OSM
  in the background, then drops that city's cached forecast so the dashboard's next
  60s poll shows the real places. Three mirrors are tried; the public ones throttle
  often, and a miss is retried after 5 minutes.
- **WAQI stations** *(optional)* — set `WAQI_TOKEN` (free from
  aqicn.org/data-platform/token) to blend real ground-station readings into the
  heatmap. Without it, everything still works.

### Why the heatmap is sampled wide

CAMS-global, which Open-Meteo serves, resolves to roughly 0.4°. Probing only the
0.18° visible box returns a single cell and a perfectly flat map. The server instead
probes a 7×7 grid over a 0.9° metro box and interpolates (inverse distance) down onto
the 16×13 display grid, so the real regional gradient shows up. Each horizon samples
the field *upwind* by `wind × hours`, which is the spillover drift the slider animates.

## How the models are used

`model_6/12/18/24.pkl` are `RandomForestRegressor`s trained on CPCB features
(`PM2.5, PM10, NO, NO2, NOx, NH3, CO, SO2, O3, Benzene, Toluene, Xylene`;
`model_24` uses 10 of those). Open-Meteo publishes most of them; **NO, NOx and the
BTX group are estimated from NO₂** using urban traffic ratios, and CO is converted
from µg/m³ to mg/m³. Those estimates are in `features_from_pollutants()` — swap in a
real feed if you have one.

The forecast band (`low`/`high`) is the spread across individual trees in the forest,
not a made-up margin. If a model fails to load, that horizon falls back to
Open-Meteo's own AQI forecast, and `meta.modelByHorizon` says which was used.

The four pickles total ~890 MB and are preloaded in a background thread at boot, so
the first request doesn't stall behind them. Expect ~1 GB RSS.

## Run

```bash
pip install -r requirements.txt
cp .env.example .env   # add your GROQ_API_KEY
python app.py          # http://localhost:8000
```

`.env` is loaded automatically (via `python-dotenv`); plain shell exports work too.

## The frontend is already wired to this

`frontend/next.config.mjs` rewrites `/api/:path*` to `BACKEND_URL`
(default `http://localhost:8000`), and the frontend's own mock routes are gone. The
components kept their relative `/api/...` URLs, so everything stays same-origin — no
CORS preflight, and SSE streams through untouched. CORS is open anyway, so hitting
`http://localhost:8000` directly from the browser also works.

Run both:

```bash
python backend/app.py            # terminal 1
cd frontend && pnpm dev          # terminal 2 -> http://localhost:3000
```

`frontend/.env.local` currently sets `BACKEND_URL=http://localhost:8001`, so start the
backend on that port to match: `PORT=8001 python backend/app.py`.

Next only reads `next.config.mjs` at startup, so restart `pnpm dev` after changing
`BACKEND_URL`.

Verified end to end: conditions, heatmap, wind arrows, risk-zone markers, the
horizon slider (`0/6/12/18/24h`) and the chat widget all render from this server.
`frontend/lib/pollution/data.ts` now only holds the city list and horizon steps —
the mock forecast generator is gone, so the backend is the single source of truth.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8000` | Listen port |
| `AQI_MODEL_DIR` | `./models`, else `../models` | Where the pickles live |
| `AQI_MODEL_BASE_URL` | — | Fetch `model_<h>.pkl` from here when missing locally |
| `AQI_USE_MODELS` | `1` | `0` skips the models entirely (fast dev boot, Open-Meteo forecasts instead) |
| `AQI_WARM_MODELS` | `1` | `0` loads models lazily on first use |
| `AQI_TREE_SAMPLE` | `150` | Trees polled for the confidence band |
| `AQI_MODEL_HORIZONS` | `6,12,18,24` | Which models to load; drop `24` to save 755MB |
| `AQI_USE_OVERPASS` | `1` | `0` uses placeholder risk zones only |
| `AQI_LOG_LEVEL` | `INFO` | Flask logger level |
| `AQI_CACHE_TTL` | `600` | Seconds a city's forecast is cached |
| `AQI_SAMPLE_SPAN` | `0.9` | Degrees of the probe box |
| `WAQI_TOKEN` | — | Enables real station readings |
| `GROQ_API_KEY` | — | Enables LLM chat replies ([console.groq.com/keys](https://console.groq.com/keys)) |
| `GROQ_BASE_URL` | `https://api.groq.com` | Bare host; the `groq` client appends `/openai/v1` |
| `AQI_CHAT_MODEL` | `openai/gpt-oss-120b` | Chat model id |
| `AQI_CHAT_REASONING_EFFORT` | `low` | gpt-oss thinking budget: `low`/`medium`/`high` |
| `AQI_CHAT_MAX_TOKENS` | `800` | Response cap |

The chat runs on **GroqCloud's `openai/gpt-oss-120b`** through the official `groq`
Python client. gpt-oss is a reasoning model, so the server sends
`reasoning_format: "hidden"` and forwards only `delta.content` — the scratchpad never
reaches the widget.

The chat bubble renders with `whitespace-pre-wrap` and has no markdown parser, so the
system prompt asks for plain text (`**bold**` would show up as literal asterisks). If
you add a markdown renderer to `chat-widget.tsx`, relax that line in
`build_system_prompt()`.

`.env` is read once, at import. If you add the key to a server that is already
running, restart it — `curl localhost:8000/api/health` shows
`chat.provider: "groq"` once it is live, and `chat.dotenvAvailable: false` if
`python-dotenv` is missing and your `.env` is being ignored.

Without `GROQ_API_KEY` the widget still answers: `/api/chat` falls back to grounded,
rule-based replies built from the live dashboard context it receives (exercise safety,
wind/spillover, AQI categories, worst zone). A bad or rate-limited key falls back the
same way instead of erroring.

## Docker

`Dockerfile` builds **this directory only** — `models/` sits next to `app.py`, so the
build context is `backend/`:

```bash
docker build -t aerocast-backend ./backend
docker run --rm -p 8000:8000 -e GROQ_API_KEY=... aerocast-backend
```

Notes on what's in it:

- `python:3.12-slim`; numpy/pandas/scikit-learn install from manylinux wheels, so no
  compiler is needed.
- `scikit-learn` is **pinned to 1.9.0** in `requirements.txt` because the pickles were
  saved from 1.9.0 and 1.6.1. Another version still unpickles, but only with warnings.
- `app.py` is copied before `models/` so code changes don't rebuild the ~880MB layer.
  The finished image is **~2.9GB** (measured) — mostly the models and the
  numpy/pandas/sklearn stack, not application code.
- Runs as a non-root user, and `.dockerignore` keeps `.env` out of the image.
- `CMD` is gunicorn with **one worker** and 8 threads. Each worker holds its own copy
  of the forests, so a second worker doubles the memory for no throughput gain.
- `$PORT` is honoured, which is what Northflank injects.

## Deploy to Northflank

Create a **combined service** (build + deploy from the repo):

| Setting | Value |
| --- | --- |
| Build type | Dockerfile |
| Dockerfile path | `/backend/Dockerfile` |
| Build context | `/backend` |
| Port | `8000`, HTTP, publicly exposed |
| Health check | HTTP `GET /api/health`, initial delay **120s** |
| Resources | **2 GB RAM** / 1 vCPU minimum |

Environment variables — add `GROQ_API_KEY` as a **secret**, not a plain variable:

```
GROQ_API_KEY   = <your key>        # secret
WAQI_TOKEN     = <optional>        # secret, adds real ground stations
```

`PORT` is injected by Northflank; don't set it yourself.

### Sizing

Measured RSS as each model loads (`model <h>h ready, rss now …` in the logs):

| after loading | RSS |
| --- | --- |
| baseline (Flask + sklearn + pandas) | 114 MB |
| + `model_6` | 394 MB |
| + `model_12` | 636 MB |
| + `model_18` | 650 MB |
| + `model_24` | **1405 MB** |

So **all four need a 2GB plan**. `model_24.pkl` accounts for 755MB of that by itself —
it is an unconstrained forest (`n_estimators=100`, no `max_depth`), unlike the other
three. On a 1GB plan, drop it:

```
AQI_MODEL_HORIZONS=6,12,18
```

+24h then falls back to Open-Meteo's own AQI forecast and everything else keeps using
the trained models; `meta.modelByHorizon` shows exactly which is which. That config
tops out around 650MB.

Standalone footprints (idle RSS, measured):

| config | RSS | fits in |
| --- | --- | --- |
| `AQI_USE_MODELS=0` | **59MB** (68MB serving) | 256MB |
| `AQI_MODEL_HORIZONS=18` | 258MB | 512MB |
| `AQI_MODEL_HORIZONS=6,12,18` | 653MB | 1GB |
| all four (default) | 1405MB | 2GB |

The jump from 59MB to 258MB for a single 32MB model is mostly scikit-learn and pandas
being imported at all, not the forest itself. `pandas` is imported lazily (it costs
56MB), so a models-off deployment never loads it.

**On a 256MB container the models cannot be used** — even one of them exceeds the limit
and the container is OOM-killed mid-warmup, which looks like a silent crashloop: clean
gunicorn boot, no traceback, restart ~30s later with widening backoff. Run with
`AQI_USE_MODELS=0` there; the dashboard is fully functional, with the +6/12/18/24h
horizons coming from Open-Meteo's forecast instead of the trained forests.

### The models can't live in a plain git repo

Northflank builds from your repository, and two of the pickles are over **GitHub's
100MB per-file limit** (`model_12.pkl` 149MB, `model_24.pkl` 571MB), so `backend/models/`
is gitignored. Pick one:

1. **`AQI_MODEL_BASE_URL`** (simplest) — upload the four files to any HTTP host (S3/R2
   bucket, GitHub Release asset) and set the variable to the directory holding them.
   Missing models are streamed into `AQI_MODEL_DIR` on first use; a failed download just
   logs and falls back to Open-Meteo for that horizon. Prefer a persistent volume for
   `AQI_MODEL_DIR` so a restart doesn't re-download ~880MB.
2. **Build the image locally and push it** to a registry (the models are baked in by the
   Dockerfile), then deploy that image on Northflank instead of building from source.
3. **Git LFS** — works, but you pay LFS bandwidth on every build.
4. **`AQI_USE_MODELS=0`** — no models at all; horizons come from Open-Meteo's forecast.

### "invalid load key, 'v'" — the models are LFS pointers

```
WARNING in app: could not load ./models/model_24.pkl: invalid load key, 'v'
INFO  in app: model warmup finished in 0.0s
```

`backend/models/*.pkl` is tracked with Git LFS, so a clone that never ran `git lfs pull`
gets ~130-byte text files starting with `version https://git-lfs.github.com/spec/v1` —
the `'v'` pickle trips over. Warmup finishing in 0.0s is the other tell.

The server now detects this and says so, and `/api/health` reports it per file:

```json
"modelFiles": { "6": "lfs-pointer (run `git lfs pull` or set AQI_MODEL_BASE_URL)" }
```

The app keeps serving — those horizons fall back to Open-Meteo's forecast, which
`meta.modelByHorizon` shows — but the trained models are not in play.

**Fix: the models are published as a GitHub Release**, and the backend fetches them on
first use. The release was created from this repo:

<https://github.com/sonroy-glitch/AQI_spillover_lab/releases/tag/models-v1>

Set this in Northflank (Environment → add variable) and redeploy:

```
AQI_MODEL_BASE_URL = https://github.com/sonroy-glitch/AQI_spillover_lab/releases/download/models-v1
```

The server then replaces each LFS pointer with the real file on first use. **Add a
persistent volume mounted at `/app/models` (≥2GB)** or every restart re-downloads 849MB
— expect a slow first boot either way; `/api/health` shows `modelFiles` turning from
`lfs-pointer` to `ok (571MB)` as they land.

To refresh the models later, upload to the same tag and restart with an empty volume:

```bash
gh release upload models-v1 backend/models/*.pkl \
  --repo sonroy-glitch/AQI_spillover_lab --clobber
```

Note the repo is public, so these assets are publicly downloadable. Move them to a
private bucket (any HTTP host works) if that is not acceptable.

Alternatives: build the image locally where the real files exist and push it to a
registry, deploying that image instead of building from source; or run with
`AQI_USE_MODELS=0` and accept Open-Meteo's horizons. Whether Northflank's builder can
run `git lfs pull` itself is not something I could confirm — check with their support
if you'd rather keep the files in the repo.

### Things that bite

- **First boot is slow.** Reading ~880MB of pickles off a cold container filesystem took
  ~40s in testing (1.8s once the page cache is warm). That is why the health check needs
  a long initial delay — the app answers `/api/health` immediately, but the first
  `/api/forecast` waits for the models.
- **Build uploads the models.** The context is ~880MB, so builds are slower than the
  Dockerfile suggests; if Northflank's build step runs out of space or time, bump the
  build plan.
- Nothing is written to disk, so no persistent volume is needed. The cache is in-process,
  which is another reason to stay at one worker/replica — two replicas simply hold
  independent caches.
- Set `BACKEND_URL` on the frontend to the service's public URL. CORS is open, so the
  browser can also call it directly.

## Production

`app.run()` is Flask's dev server. Behind gunicorn use one worker — the models are
per-process and ~1 GB each:

```bash
gunicorn -w 1 -k gthread --threads 8 -t 120 -b 0.0.0.0:8000 app:app
```
