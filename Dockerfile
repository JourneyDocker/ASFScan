FROM python:3.14.1-alpine

# Install dependencies
RUN apk add --no-cache curl jq tzdata

# Set working directory
WORKDIR /app

# Copy requirements and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Set environment variables
ENV PYTHONUNBUFFERED=1

# Command to run the application
CMD ["python", "ASFScan.py"]

# Health check to ensure the application is up and running
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl --silent --fail http://localhost:3000/health | jq -e '.status == "running"' > /dev/null || exit 1
