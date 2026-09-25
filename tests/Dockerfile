FROM python:3.13-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN pip install pytest==9.1.1 pytest-json-ctrf==0.5.2 playwright==1.49.1
RUN python -m playwright install --only-shell --with-deps chromium && rm -rf /var/lib/apt/lists/*

COPY . /tests/

RUN mkdir -p /workspace /logs/verifier
