FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HTMLEDITOR_DB=/data/annotations.db

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY server ./server
COPY static ./static
COPY landing/demo-2026-07 ./landing/demo-2026-07

RUN mkdir -p /data

EXPOSE 8080

CMD ["sh", "-c", ".venv/bin/uvicorn server.app:app --host 0.0.0.0 --port ${PORT:-8080}"]
