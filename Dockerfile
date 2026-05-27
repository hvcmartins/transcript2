FROM python:3.12-slim

LABEL maintainer="rdtlTranscript"
LABEL description="AI transcription powered by Groq Whisper — no GPU required"

WORKDIR /app

# Install Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY . .

# Create default data directories (used when no volume is mounted)
RUN mkdir -p /app/uploads /app/data

ENV PORT=6133 \
    HOST=0.0.0.0 \
    UPLOAD_DIR=/app/uploads \
    DATA_DIR=/app/data

EXPOSE 6133

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:6133/api/health')" || exit 1

CMD ["sh", "-c", "uvicorn main:app --host $HOST --port $PORT"]
