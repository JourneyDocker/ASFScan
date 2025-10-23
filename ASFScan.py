import os
import time
import re
import threading
import http.server
import socketserver
import json
from threading import Thread
import praw
from github import Github, GithubException, InputFileContent, Auth
from dotenv import load_dotenv

# Import custom logger
from lib.logger import logger

# Version information
VERSION = "2.1.1-dev3"

# Load environment variables from .env file
load_dotenv()

# Configure GitHub and Reddit clients
github = Github(auth=Auth.Token(os.environ.get('ghToken')))
reddit = praw.Reddit(
    user_agent=f"ASFScan:v{VERSION} (by u/Static_Love; bot for monitoring free games)",
    client_id=os.environ.get('clientId'),
    client_secret=os.environ.get('clientSecret'),
    username=os.environ.get('RedditUsername'),
    password=os.environ.get('RedditPassword')
)

# Constants and state tracking
BOT_START = int(time.time()) # Bot start time
LAST_PROCESSED = BOT_START # Last processed comment timestamp
processed_comment_ids = set() # Processed comment IDs
MAX_PROCESSED_COMMENTS = 1000 # Max processed comments to keep
processed_licenses = set() # Processed license commands
update_queue = [] # Update queue for pending updates
update_lock = threading.Lock() # Lock for synchronizing updates

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
        for _ in range(len(processed_comment_ids) - MAX_PROCESSED_COMMENTS):
            processed_comment_ids.pop()

    license_commands = extract_license_commands(comment.body)
    new_licenses = [license for license in license_commands if license not in processed_licenses]

    logger["processed_comment_debug"](subreddit_name, len(license_commands), len(new_licenses))

    if new_licenses:
        for license in new_licenses:
            processed_licenses.add(license)
        logger["processing_comment"](comment.submission.title, subreddit_name, new_licenses)
        enqueue_update(new_licenses)

# Merge new licenses with existing content
def merge_unique_content(existing_content, new_content):
    return [line for line in existing_content if line not in new_content] + list(new_content)

# Check if the content has changed
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

    logger["latest_gist_update_failed"]()

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

# Function to process the update queue
def queue_worker():
    while True:
        license_commands = None
        with update_lock:
            if update_queue:
                license_commands = update_queue.pop(0)
        if license_commands:
            try:
                update_gist(license_commands)
            except Exception as e:
                logger["queue_processing_error"](str(e))
        else:
            time.sleep(1)

# Add update to the queue
def enqueue_update(license_commands):
    with update_lock:
        update_queue.append(license_commands)

# Start the queue worker thread
def start_queue_worker():
    worker_thread = threading.Thread(target=queue_worker)
    worker_thread.daemon = True
    worker_thread.start()
    logger["queue_worker_started"]()

# Stream comments from a single subreddit
def stream_comments(subreddit_name):
    logger["starting_stream"](subreddit_name)
    subreddit = reddit.subreddit(subreddit_name)
    retry_count = 0
    while True:
        try:
            for comment in subreddit.stream.comments(skip_existing=True):
                process_comment(comment, subreddit_name)
            retry_count = 0  # Reset on success
        except Exception as e:
            logger["fetch_error"](subreddit_name, e)
            sleep_time = 10 * (2 ** retry_count)
            if sleep_time > 600:  # Cap at 10 minutes
                sleep_time = 600
            time.sleep(sleep_time)
            retry_count += 1

# Catch up on missed comments
def catch_up_comments():
    global LAST_PROCESSED
    logger["starting_catchup"]()
    for subreddit_name in subreddits:
        try:
            subreddit = reddit.subreddit(subreddit_name)
            for comment in subreddit.comments(limit=100):
                if comment.created_utc > LAST_PROCESSED:
                    process_comment(comment, subreddit_name)
        except Exception as e:
            logger["fetch_error"](subreddit_name, e)
            time.sleep(5)  # Small delay before trying next subreddit
    LAST_PROCESSED = int(time.time())
    logger["catchup_completed"]()

# Hybrid monitoring function
def hybrid_reddit_monitor():
    stream_threads = []
    for subreddit_name in subreddits:
        thread = threading.Thread(target=stream_comments, args=(subreddit_name,))
        thread.daemon = True
        thread.start()
        stream_threads.append(thread)
    while True:
        catch_up_comments()
        time.sleep(300)

# Poll subreddits for new comments
def start_polling():
    monitor_thread = threading.Thread(target=hybrid_reddit_monitor)
    monitor_thread.daemon = True
    monitor_thread.start()

# Health check endpoint
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

# Start the health check server
def start_health_server(port):
    handler = HealthCheckHandler
    server = socketserver.TCPServer(("0.0.0.0", port), handler)
    server_thread = Thread(target=server.serve_forever)
    server_thread.daemon = True
    server_thread.start()
    logger["health_server_started"](port)

# Main entry point
if __name__ == "__main__":
    logger["bot_started"](VERSION)

    start_queue_worker()
    start_polling()

    port = int(os.environ.get('PORT', 3000))
    start_health_server(port)

    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        logger["bot_shutting_down"]()
