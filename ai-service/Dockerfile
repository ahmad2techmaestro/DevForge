FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
# git: clone/diff repos. docker CLI: launch isolated sandbox containers via the mounted socket.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates docker.io \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv/agent
COPY pyproject.toml ./
COPY app ./app
RUN pip install .
EXPOSE 8000
ENV PORT=8000
HEALTHCHECK --interval=15s --timeout=3s CMD python -c "import os, urllib.request as u; u.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT', '8000'))"
# Hosts such as Render pass the port to listen on in $PORT.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
