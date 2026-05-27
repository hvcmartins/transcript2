FROM node:24-alpine

LABEL maintainer="rdtlTranscript"
LABEL description="AI transcription powered by Groq Whisper — no GPU required"

# Build tools for native addons (better-sqlite3), then runtime lib
RUN apk add --no-cache python3 make g++ libstdc++

# Create non-root user
RUN addgroup -S rdtl && adduser -S rdtl -G rdtl

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json ./
RUN npm install --omit=dev --prefer-offline 2>&1

# Copy application source
COPY --chown=rdtl:rdtl . .

# Create persistent data directories
RUN mkdir -p /app/uploads /app/data && \
    chown -R rdtl:rdtl /app/uploads /app/data /app/node_modules

USER rdtl

VOLUME ["/app/uploads", "/app/data"]

ENV NODE_ENV=production \
    PORT=6133 \
    HOST=0.0.0.0 \
    UPLOAD_DIR=/app/uploads \
    DATA_DIR=/app/data

EXPOSE 6133

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:6133/api/health || exit 1

CMD ["node", "server.js"]
