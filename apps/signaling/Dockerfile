# Drivee signalling server (FastAPI + uvicorn).
# Build from this directory:  docker build -t drivee-signaling apps/signaling

# --- Build stage: resolve dependencies from uv.lock into a virtualenv ---
FROM python:3.12-slim AS build

COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app

# Dependencies first, so code changes don't invalidate this layer.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

COPY signaling ./signaling
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

# --- Runtime stage: just Python and the virtualenv ---
FROM python:3.12-slim

RUN useradd --create-home --uid 1000 app

COPY --from=build --chown=app:app /app/.venv /app/.venv

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PORT=8000

USER app
EXPOSE 8000

# Rooms and accounts live in process memory, so run a single worker.
# --proxy-headers trusts X-Forwarded-* from the reverse proxy in front of it.
CMD ["sh", "-c", "exec uvicorn signaling.app:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
