FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

COPY services/price-validator/requirements.txt /tmp/requirements.txt
RUN PIP_CONFIG_FILE=/dev/null PIP_REQUIRE_HASHES=0 pip install --no-cache-dir -r /tmp/requirements.txt

COPY services/price-validator/app /app/app

EXPOSE 8006

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8006"]
