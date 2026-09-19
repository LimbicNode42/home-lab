# Mem0 self-hosted API server (production build, pinned mem0ai)
# Build context: /opt/mem0-src/server
FROM python:3.12-slim

WORKDIR /app

# libpq5 provides the libpq shared library that psycopg (Postgres driver) needs.
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 && \
    rm -rf /var/lib/apt/lists/*

# Pin mem0ai to the version matching the cloned server source (2.1.0)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir "mem0ai==2.1.0"

COPY . .

EXPOSE 8000
ENV PYTHONUNBUFFERED=1

# No --reload in production
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
