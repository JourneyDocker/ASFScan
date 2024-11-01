# Use an Alpine-based Node.js image
FROM node:lts-alpine

# Install dependencies and set up app directory
RUN apk add --no-cache curl tzdata && \
    mkdir -p /app && \
    chown -R node:node /app

# Set working directory and copy package.json for dependency installation
WORKDIR /app
COPY package.json ./

# Install dependencies and clear npm cache
RUN npm install --omit=dev && \
    npm cache clean --force

# Copy application source code
COPY --chown=node:node . .

# Use non-root user and set default command
USER node
CMD ["node", "index.js"]

# Health check to ensure the application is up and running
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl --silent --fail http://localhost:3000/health | grep -q "Bot is alive and running." || exit 1
