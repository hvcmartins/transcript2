FROM python:3.12-slim

LABEL maintainer="rdtlTranscript"
LABEL description="AI transcription powered by Groq Whisper — local CPU fallback included"

# Set WITH_OPENVINO=true to add Intel GPU support (adds ~1 GB to the image)
ARG WITH_OPENVINO=false

WORKDIR /app

# System dependencies:
#   ffmpeg      — audio format conversion (preprocessing + diarization)
#   libsndfile1 — required by soundfile (audio I/O)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
  && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Optional: OpenVINO GenAI for Intel GPU transcription
RUN if [ "$WITH_OPENVINO" = "true" ]; then \
      pip install --no-cache-dir openvino-genai; \
    fi

# Pre-warm librosa/numba JIT cache so the first diarization run is fast
RUN python -c "\
import numpy as np, librosa; \
y = np.zeros(16000, dtype=np.float32); \
librosa.feature.mfcc(y=y, sr=16000, n_mfcc=20)" 2>/dev/null || true

# Copy application source
COPY . .

# Create default data directories (used when no volume is mounted)
RUN mkdir -p /app/uploads /app/data /app/models

ENV PORT=6133 \
    HOST=0.0.0.0 \
    UPLOAD_DIR=/app/uploads \
    DATA_DIR=/app/data \
    MODELS_DIR=/app/models \
    ENABLE_DIARIZATION=true \
    LOCAL_DEVICE=cpu \
    LOCAL_COMPUTE_TYPE=int8

EXPOSE 6133

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:6133/api/health')" || exit 1

CMD ["sh", "-c", "uvicorn main:app --host $HOST --port $PORT"]
