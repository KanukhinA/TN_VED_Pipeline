FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

COPY services/preprocessing/requirements.txt /tmp/requirements.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends docker.io \
    && rm -rf /var/lib/apt/lists/*
RUN PIP_CONFIG_FILE=/dev/null PIP_REQUIRE_HASHES=0 pip install --no-cache-dir -r /tmp/requirements.txt

COPY services/preprocessing/app /app/app
COPY shared/json_recovery.py /app/app/json_recovery.py
COPY shared/llm_runtime /app/shared/llm_runtime
COPY config/llm_models.json /app/config/llm_models.json

ENV MODEL_RUNTIME_SETTINGS_PATH=/app/config/llm_models.json

EXPOSE 8004

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8004"]
