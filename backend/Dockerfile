FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TORCH_HOME=/app/.cache/torch

WORKDIR /app

# ffmpeg is required for transcoding/probing.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install CPU-only torch first to avoid pulling huge CUDA wheels.
RUN pip install --index-url https://download.pytorch.org/whl/cpu \
    torch==2.5.1 torchaudio==2.5.1

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
