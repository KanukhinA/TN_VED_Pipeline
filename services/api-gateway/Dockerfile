FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

COPY services/api-gateway/requirements.txt /tmp/requirements.txt
RUN PIP_CONFIG_FILE=/dev/null PIP_REQUIRE_HASHES=0 pip install --no-cache-dir -r /tmp/requirements.txt

COPY services/api-gateway/app /app/app
COPY services/api-gateway/config /app/config
COPY shared/json_recovery.py /app/app/json_recovery.py

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
