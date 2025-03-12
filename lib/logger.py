from datetime import datetime

# Log levels for consistent message formatting
log_levels = {
    "INFO": "[INFO]",
    "WARN": "[WARN]",
    "ERROR": "[ERROR]",
    "UNKNOWN": "[UNKNOWN]"
}

# Main logging function with timestamp and log level
def log(level, message):
    timestamp = datetime.now().strftime("%m/%d/%Y, %I:%M:%S %p")
    print(f"[{timestamp}] {log_levels.get(level, log_levels['UNKNOWN'])} {message}")

# Simple wrapper functions for each log level
def info(message):
    log("INFO", message)

def warn(message):
    log("WARN", message)

def error(message):
    log("ERROR", message)

# Handle fetch errors from subreddit interactions
def fetch_error(subreddit, error_obj):
    status_code = getattr(error_obj, 'status_code', None)
    message = str(error_obj)

    # Server errors or connectivity issues trigger a delay
    if status_code in [500, 502]:
        warn(f"Server error (HTTP {status_code}) from subreddit {subreddit}. Switching to 10-minute delay.")
    elif "getaddrinfo EAI_AGAIN" in message or "ECONNRESET" in message:
        warn(f"Network issue with subreddit {subreddit}: {message}. Switching to 10-minute delay.")
    else:
        error(f"Unexpected error while fetching comments from {subreddit}: {message}. Switching to 10-minute delay.")

# Handle errors while updating Gists
def gist_update_error(gist_name, error_obj):
    status = getattr(error_obj, 'status', None)
    message = str(error_obj)

    if status == 409:
        warn(f"Conflict updating Gist ({gist_name}): {message}. Retrying shortly.")
    else:
        error(f"Failed to update Gist ({gist_name}): {message}. Retrying shortly.")

# Log message when processing a comment with new license IDs
def processing_comment(thread_title, subreddit, new_licenses):
    info(f"Processing comment in thread \"{thread_title}\" from subreddit {subreddit} with License IDs: {', '.join(new_licenses)}")

# Log success when a Gist is successfully updated
def gist_update_success(filename):
    info(f"Gist content for {filename} updated successfully.")

# Log message when no new licenses are added
def no_new_licenses():
    info("No new licenses added: All detected licenses were either already processed previously or are already present at the bottom of the list.")

# Log message for API rate limits
def rate_limit(service, retry_after):
    warn(f"{service} API rate limit reached. Waiting {retry_after} seconds before retrying.")

# Make the logger functions available as module attributes
logger = {
    "info": info,
    "warn": warn,
    "error": error,
    "fetch_error": fetch_error,
    "gist_update_error": gist_update_error,
    "processing_comment": processing_comment,
    "gist_update_success": gist_update_success,
    "no_new_licenses": no_new_licenses,
    "rate_limit": rate_limit
}
