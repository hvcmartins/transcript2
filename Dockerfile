# ─── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# Install build tools needed for native addons (better-sqlite3)
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./

# Install all deps and rebuild native modules for this exact platform
RUN npm ci --omit=dev && \
    npm rebuild better-sqlite3

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:24-alpine

LABEL maintainer="Transcribify"
LABEL description="TurboScribe clone powered by Groq Whisper"
LABEL org.opencontainers.image.title="Transcribify"
LABEL org.opencontainers.image.description="AI transcription service using Groq Whisper"

# Runtime deps for better-sqlite3
RUN apk add --no-cache libstdc++

# Create non-root user
RUN addgroup -S transcribify && adduser -S transcribify -G transcribify

WORKDIR /app

# Copy compiled node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY --chown=transcribify:transcribify . .

# Create required directories
RUN mkdir -p /app/uploads /app/data && \
    chown -R transcribify:transcribify /app/uploads /app/data

USER transcribify

VOLUME ["/app/uploads", "/app/data"]

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    UPLOAD_DIR=/app/uploads \
    DATA_DIR=/app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
