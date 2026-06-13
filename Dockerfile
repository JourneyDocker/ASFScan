# Stage 0: Base
FROM python:3.14.6-alpine AS base

# Set the working directory
WORKDIR /app

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"

# Stage 1: Build
FROM base AS build

# Create a Python virtual environment
RUN python -m venv /opt/venv

# Upgrade pip and install Python dependencies
COPY requirements.txt .
RUN pip install --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY . .

# Stage 2: Final
FROM base AS final

# Install runtime system dependencies
RUN apk add --no-cache curl jq tzdata

# Copy the virtual environment and application code from the build stage
COPY --from=build /opt/venv /opt/venv
COPY --from=build /app .

# Set the default command
CMD ["python", "ASFScan.py"]

# Configure the health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl --silent --fail http://localhost:3000/health | jq -e '.status == "running"' > /dev/null || exit 1
