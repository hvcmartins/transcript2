FROM python:3.12-slim

LABEL maintainer="rdtlTranscript"
LABEL description="AI transcription powered by Groq Whisper — no GPU required"

WORKDIR /app

# System dependencies:
#   ffmpeg      — audio format conversion for speaker diarization
#   libsndfile1 — required by soundfile (audio I/O)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
  && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Pre-warm librosa/numba JIT cache so the first diarization run is fast
RUN python -c "\
import numpy as np, librosa; \
y = np.zeros(16000, dtype=np.float32); \
librosa.feature.mfcc(y=y, sr=16000, n_mfcc=20)" 2>/dev/null || true

# Copy application source
COPY . .

# Create default data directories (used when no volume is mounted)
RUN mkdir -p /app/uploads /app/data

ENV PORT=6133 \
    HOST=0.0.0.0 \
    UPLOAD_DIR=/app/uploads \
    DATA_DIR=/app/data \
    ENABLE_DIARIZATION=true

EXPOSE 6133

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:6133/api/health')" || exit 1

CMD ["sh", "-c", "uvicorn main:app --host $HOST --port $PORT"]
