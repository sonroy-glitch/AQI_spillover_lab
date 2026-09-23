# AeroCast backend — build with this directory as the context:
#   docker build -t aerocast-backend ./backend
# models/ lives next to app.py, so it is copied in with everything else.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000 \
    AQI_MODEL_DIR=/app/models

WORKDIR /app

# numpy / pandas / scikit-learn all ship manylinux wheels for CPython 3.12,
# so no compiler is needed in the image.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# app.py first, then the ~880MB of pickles, so code edits don't invalidate the
# expensive layer.
COPY app.py .
COPY models/ ./models/

# Run unprivileged; nothing here writes to disk.
RUN useradd --create-home --uid 10001 aerocast && chown -R aerocast:aerocast /app
USER aerocast

EXPOSE 8000

# Northflank polls this too; the app answers before the models finish warming.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('PORT','8000')}/api/health\", timeout=4)"

# One worker: each holds its own ~800MB copy of the forests. Threads give
# concurrency instead. The long timeout covers a cold model load on first use.
# Shell form so $PORT (injected by Northflank) is expanded.
CMD gunicorn --bind "0.0.0.0:${PORT}" \
    --workers 1 --worker-class gthread --threads 8 \
    --timeout 180 --graceful-timeout 30 --keep-alive 65 \
    --access-logfile - --error-logfile - \
    app:app
