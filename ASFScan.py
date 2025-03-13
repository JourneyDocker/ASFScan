import os
import time
import re
import threading
import http.server
import socketserver
import json
from threading import Thread
import praw
from github import Github, GithubException, InputFileContent
from dotenv import load_dotenv

# Import custom logger
from lib.logger import logger

# Version information
VERSION = "2.0.0-dev3"

# Load environment variables from .env file
load_dotenv()

# Configure GitHub and Reddit clients
github = Github(os.environ.get('ghToken'))
reddit = praw.Reddit(
    user_agent=f"ASFScan:v{VERSION} (by u/Static_Love; bot for monitoring free games)",
    client_id=os.environ.get('clientId'),
    client_secret=os.environ.get('clientSecret'),
    username=os.environ.get('RedditUsername'),
    password=os.environ.get('RedditPassword')
)

# Constants and state tracking
BOT_START = int(time.time())  # Bot start timestamp
processed_comment_ids = set()  # Track processed comments
MAX_PROCESSED_COMMENTS = 1000  # Limit memory usage
processed_licenses = set()  # Track processed licenses
update_queue = []  # Queue for sequential Gist updates
update_lock = threading.Lock()  # Lock for thread safety

# Subreddits to monitor
subreddits = [
    "FreeGameFindings",
    "FreeGamesForPC",
#    "testingground4bots",
    "FreeGamesForSteam",
    "FreeGamesOnSteam",
    "freegames",
    "Freegamestuff",
]

# Function to extract license commands from comment body
def extract_license_commands(comment_body):
    license_pattern = r'(?:!?addlicense)\s+(?:asf\s+)?((?:[as]\/\d+|app\/\d+)(?:,\s*(?:[as]\/\d+|app\/\d+))*)'
    license_commands = set()

    for match in re.finditer(license_pattern, comment_body, re.IGNORECASE):
        licenses = match.group(1).strip()
        licenses = re.sub(r'\bapp\/', 'a/', licenses)
        licenses = re.sub(r'\bsub\/', 's/', licenses)
        for license in licenses.split(','):
            license_commands.add(license.strip())

    return license_commands

# Process a comment for license commands
def process_comment(comment, subreddit_name):
    if comment.created_utc < BOT_START or comment.id in processed_comment_ids:
        return

    processed_comment_ids.add(comment.id)
    # Limit the size of processed_comment_ids to prevent memory growth
    if len(processed_comment_ids) > MAX_PROCESSED_COMMENTS:
        # Remove oldest items (approximation since sets don't maintain order)
        to_remove = len(processed_comment_ids) - MAX_PROCESSED_COMMENTS
        for _ in range(to_remove):
            processed_comment_ids.pop()

    license_commands = extract_license_commands(comment.body)
    new_licenses = [license for license in license_commands if license not in processed_licenses]

    if new_licenses:
        for license in new_licenses:
            processed_licenses.add(license)
        logger["processing_comment"](comment.submission.title, subreddit_name, new_licenses)
        enqueue_update(new_licenses)

# Merge new licenses with existing content
def merge_unique_content(existing_content, new_content):
    return [line for line in existing_content if line not in new_content] + list(new_content)

# Check if content has changed
def has_content_changed(existing_content, updated_content):
    if len(existing_content) != len(updated_content):
        return True

    for i, line in enumerate(existing_content):
        if i >= len(updated_content) or line != updated_content[i]:
            return True

    return False

# Update content of a specific Gist file
def update_gist_content(gist_id, filename, content):
    try:
        gist = github.get_gist(gist_id)
        gist.edit(files={filename: InputFileContent(content)})
        logger["gist_update_success"](filename)
    except GithubException as e:
        # Check for rate limiting
        if e.status == 403 and 'rate limit' in str(e).lower():
            retry_after = int(e.headers.get('Retry-After', 60))
            logger["rate_limit"]("GitHub", retry_after)
            time.sleep(retry_after)
            # Retry after waiting
            update_gist_content(gist_id, filename, content)
        else:
            raise

# Update the main "Steam Codes" Gist
def update_gist(license_commands):
    max_retries = 3
    retry_count = 0

    while retry_count < max_retries:
        try:
            gist_id = os.environ.get('gistId')
            gist = github.get_gist(gist_id)
            existing_content = gist.files["Steam Codes"].content.split("\n")
            updated_content = merge_unique_content(existing_content, license_commands)
            recent_content = existing_content[-40:] if len(existing_content) >= 40 else existing_content
            new_licenses_not_in_recent = [license for license in license_commands if license not in recent_content]

            if new_licenses_not_in_recent and has_content_changed(existing_content, updated_content):
                update_gist_content(gist_id, "Steam Codes", "\n".join(updated_content))
                update_latest_gist(license_commands)
            else:
                logger["no_new_licenses"]()
            return
        except Exception as e:
            logger["gist_update_error"]("Steam Codes", e)
            retry_count += 1
            # Exponential backoff
            time.sleep(5 * retry_count)

    logger["error"]("Failed to update gist after multiple retries")

# Update the "Latest Steam Games" Gist with recent licenses
def update_latest_gist(license_commands):
    max_retries = 3
    retry_count = 0

    while retry_count < max_retries:
        try:
            gist = github.get_gist("2a611b12813fc06e17b89fcf00834e8c")
            existing_content = gist.files["Latest Steam Games"].content.split("\n")
            updated_content = merge_unique_content(existing_content, license_commands)

            # Keep last 40 entries
            if len(updated_content) > 40:
                updated_content = updated_content[-40:]

            if has_content_changed(existing_content, updated_content):
                update_gist_content(gist.id, "Latest Steam Games", "\n".join(updated_content))
            return
        except Exception as e:
            logger["gist_update_error"]("Latest Steam Games", e)
            retry_count += 1
            # Exponential backoff
            time.sleep(5 * retry_count)

    logger["error"]("Failed to update latest gist after multiple retries")

# Add update to the queue
def enqueue_update(license_commands):
    with update_lock:
        update_queue.append(license_commands)
    process_queue()

# Process updates from the queue
def process_queue():
    with update_lock:
        if not update_queue:
            return
        license_commands = update_queue.pop(0)

    try:
        update_gist(license_commands)
    except Exception as e:
        logger["error"](f"Error processing queue: {str(e)}")
    finally:
        # Process next item if any
        with update_lock:
            if update_queue:
                # Use threading to avoid recursion
                threading.Thread(target=process_queue).start()

# Poll subreddits for new comments
def poll_subreddits():
    while True:
        delay = 20  # Default delay in seconds
        processed_licenses.clear()  # Reset processed licenses

        for subreddit_name in subreddits:
            try:
                subreddit = reddit.subreddit(subreddit_name)
                for comment in subreddit.comments(limit=100):
                    process_comment(comment, subreddit_name)
            except Exception as e:
                # Check for Reddit rate limits
                if hasattr(e, 'response') and e.response.status_code == 429:
                    retry_after = int(e.response.headers.get('Retry-After', 600))
                    logger["rate_limit"]("Reddit", retry_after)
                    delay = retry_after
                else:
                    logger["fetch_error"](subreddit_name, e)
                    delay = 600  # Increase delay to 10 minutes on error

        # Ensure delay is always positive
        safe_delay = max(1, delay)
        time.sleep(safe_delay)

# Custom HTTP handler for health check
class HealthCheckHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            uptime = int(time.time()) - BOT_START
            uptime_str = f"{uptime // 86400}d {(uptime % 86400) // 3600}h {(uptime % 3600) // 60}m {uptime % 60}s"

            health_info = {
                "status": "running",
                "version": VERSION,
                "uptime": uptime_str,
                "processed_comments": len(processed_comment_ids),
                "queued_updates": len(update_queue),
                "monitored_subreddits": len(subreddits)
            }

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(health_info).encode())
        else:
            self.send_response(404)
            self.send_header('Content-type', 'text/plain')
            self.end_headers()
            self.wfile.write(b"Not found")

    def log_message(self, format, *args):
        # Suppress default logging
        return

# Start HTTP server for health check in a separate thread
def start_health_server(port):
    handler = HealthCheckHandler
    server = socketserver.TCPServer(("0.0.0.0", port), handler)
    server_thread = Thread(target=server.serve_forever)
    server_thread.daemon = True
    server_thread.start()
    logger["info"](f"Health check server started on port {port}")

# Start polling in a separate thread
def start_polling():
    polling_thread = threading.Thread(target=poll_subreddits)
    polling_thread.daemon = True
    polling_thread.start()

if __name__ == "__main__":
    logger["info"](f"ASFScan v{VERSION} started and monitoring subreddits...")
    start_polling()

    # Start the health check server
    port = int(os.environ.get('PORT', 3000))
    start_health_server(port)

    # Keep the main thread running
    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        logger["info"]("Bot shutting down...")
