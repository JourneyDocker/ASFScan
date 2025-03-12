# Use an Alpine-based bun image
FROM oven/bun:1.2.5-alpine

# Install dependencies and set up app directory
RUN apk add --no-cache curl tzdata && \
    mkdir -p /app && \
    chown -R bun:bun /app

# Set working directory and copy package.json for dependency installation
WORKDIR /app
COPY package.json ./

# Install dependencies
RUN bun install

# Copy application source code
COPY --chown=bun:bun . .

# Use non-root user and set default command
USER bun
CMD ["bun", "index.js"]

# Health check to ensure the application is up and running
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl --silent --fail http://localhost:3000/health | grep -q "Bot is alive and running." || exit 1
