FROM node:alpine

WORKDIR /usr/src/app

# Expose the port that your application will run on
EXPOSE 3000

# Install curl to use in the health check
RUN apk add --no-cache curl tzdata

# Copy package.json and package-lock.json (or npm-shrinkwrap.json) and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of your application code
COPY . .

# Define the command to run your application
CMD ["node", "index.js"]

# Health check to ensure the application is up and running
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl --silent --fail http://localhost:3000/health | grep -q "Bot is alive and running." || exit 1
