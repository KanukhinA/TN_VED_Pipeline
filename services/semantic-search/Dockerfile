FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

COPY services/semantic-search/requirements.txt /tmp/requirements.txt
RUN PIP_CONFIG_FILE=/dev/null PIP_REQUIRE_HASHES=0 pip install --no-cache-dir --retries 10 --timeout 120 --index-url https://download.pytorch.org/whl/cpu torch==2.5.1+cpu
RUN PIP_CONFIG_FILE=/dev/null PIP_REQUIRE_HASHES=0 pip install --no-cache-dir --retries 10 --timeout 120 -r /tmp/requirements.txt

COPY services/semantic-search/app /app/app

EXPOSE 8001

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
