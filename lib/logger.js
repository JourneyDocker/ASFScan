// Log levels for consistent message formatting
const logLevels = {
  INFO: "[INFO]",
  WARN: "[WARN]",
  ERROR: "[ERROR]",
  UNKNOWN: "[UNKNOWN]"
};

// Main logging function with timestamp and log level
const log = (level, message) => {
  const timestamp = new Date().toLocaleString("en-US", { hour12: true });
  console.log(`[${timestamp}] ${logLevels[level] || logLevels.UNKNOWN} ${message}`);
};

// Simple wrapper functions for each log level
const info = (message) => log("INFO", message);
const warn = (message) => log("WARN", message);
const error = (message) => log("ERROR", message);

// Handle fetch errors from subreddit interactions
const fetchError = (subreddit, { statusCode, message }) => {
  // Server errors or connectivity issues trigger a delay
  if ([500, 502].includes(statusCode)) {
    warn(`Server error (HTTP ${statusCode}) from subreddit ${subreddit}. Switching to 10-minute delay.`);
  } else if (message.includes("getaddrinfo EAI_AGAIN") || message.includes("ECONNRESET")) {
    warn(`Network issue with subreddit ${subreddit}: ${message}. Switching to 10-minute delay.`);
  } else {
    error(`Unexpected error while fetching comments from ${subreddit}: ${message}. Switching to 10-minute delay.`);
  }
};

// Handle errors while updating Gists
const gistUpdateError = (gistName, { status, message }) => {
  if (status === 409) {
    warn(`Conflict updating Gist (${gistName}): ${message}. Retrying shortly.`);
  } else {
    error(`Failed to update Gist (${gistName}): ${message}. Retrying shortly.`);
  }
};

// Log message when processing a comment with new license IDs
const processingComment = (threadTitle, subreddit, newLicenses) =>
  info(`Processing comment in thread "${threadTitle}" from subreddit ${subreddit} with License IDs: ${newLicenses.join(", ")}`);

// Log success when a Gist is successfully updated
const gistUpdateSuccess = (filename) => info(`Gist content for ${filename} updated successfully.`);

// Log message when no new licenses are added
const noNewLicenses = () => info("No new licenses added: All detected licenses were either already processed previously or are already present at the bottom of the list.");

// Exporting all logging functions for use in other modules
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
