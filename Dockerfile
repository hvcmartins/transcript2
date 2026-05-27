FROM node:24-alpine

LABEL maintainer="Transcribify"
LABEL description="TurboScribe clone powered by Groq Whisper"

# Build tools for native addons (better-sqlite3), then runtime lib
RUN apk add --no-cache python3 make g++ libstdc++

# Create non-root user
RUN addgroup -S transcribify && adduser -S transcribify -G transcribify

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json ./
RUN npm install --omit=dev --prefer-offline 2>&1

# Copy application source
COPY --chown=transcribify:transcribify . .

# Create persistent data directories
RUN mkdir -p /app/uploads /app/data && \
    chown -R transcribify:transcribify /app/uploads /app/data /app/node_modules

USER transcribify

VOLUME ["/app/uploads", "/app/data"]

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    UPLOAD_DIR=/app/uploads \
    DATA_DIR=/app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
