FROM python:3.12-slim

LABEL maintainer="rdtlTranscript"
LABEL description="AI transcription powered by Groq Whisper — no GPU required"

# No native compilation — Python's sqlite3 is built into the interpreter

# Create non-root user
RUN groupadd -r rdtl && useradd -r -g rdtl rdtl

WORKDIR /app

# Install Python dependencies (pure-Python wheels, no build tools needed)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY --chown=rdtl:rdtl . .

# Create persistent data directories
RUN mkdir -p /app/uploads /app/data && \
    chown -R rdtl:rdtl /app/uploads /app/data

USER rdtl

VOLUME ["/app/uploads", "/app/data"]

ENV PORT=6133 \
    HOST=0.0.0.0 \
    UPLOAD_DIR=/app/uploads \
    DATA_DIR=/app/data

EXPOSE 6133

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:6133/api/health')" || exit 1

CMD ["sh", "-c", "uvicorn main:app --host $HOST --port $PORT"]
