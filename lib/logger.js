const logLevels = {
  INFO: "[INFO]",
  WARN: "[WARN]",
  ERROR: "[ERROR]",
  UNKNOWN: "[UNKNOWN]"
};

const log = (level, message) => {
  const timestamp = new Date().toLocaleString("en-US", { hour12: true });
  console.log(`[${timestamp}] ${logLevels[level] || logLevels.UNKNOWN} ${message}`);
};

// Simple log level methods
const info = (message) => log("INFO", message);
const warn = (message) => log("WARN", message);
const error = (message) => log("ERROR", message);

// Centralized error handling for fetch and gist updates
const fetchError = (subreddit, { statusCode, message }) => {
  if ([500, 502].includes(statusCode)) {
    warn(`Server error (HTTP ${statusCode}) from subreddit ${subreddit}. Switching to 10-minute delay due to error.`);
  } else if (message.includes("getaddrinfo EAI_AGAIN") || message.includes("ECONNRESET")) {
    warn(`Network connectivity issue while accessing subreddit ${subreddit}: ${message}. Switching to 10-minute delay due to error.`);
  } else {
    error(`Unexpected error occurred while fetching comments from ${subreddit}: ${message}. Switching to 10-minute delay due to error.`);
  }
};

const gistUpdateError = (gistName, { status, message }) => {
  if (status === 409) {
    warn(`Conflict encountered while updating Gist (${gistName}): ${message}. Retrying shortly.`);
  } else {
    error(`Failed to update Gist (${gistName}) due to an error: ${message}.  Retrying shortly`);
  }
};

// Combined methods for processing results
const processingComment = (threadTitle, subreddit, newLicenses) =>
  info(`Processing comment in thread "${threadTitle}" from subreddit ${subreddit} with License IDs: ${newLicenses.join(", ")}`);

const gistUpdateSuccess = (filename) => info(`Gist content for ${filename} updated successfully.`);
const noNewLicenses = () => info("No new licenses added: All found licenses are already present.");

// Exporting all functions
export default {
  info,
  warn,
  error,
  fetchError,
  gistUpdateError,
  processingComment,
  gistUpdateSuccess,
  noNewLicenses
};
