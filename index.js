import "dotenv/config";
import snoowrap from "snoowrap";
import { Octokit } from "@octokit/rest";
import express from "express";

// Import custom logger module
import logger from "./lib/logger.js";

// Initialize Express app
const app = express();

// Octokit and snoowrap configuration
const octokit = new Octokit({ auth: `token ${process.env.ghToken}` });

const snoowrapConfig = {
  userAgent: process.env.userAgent,
  clientId: process.env.clientId,
  clientSecret: process.env.clientSecret,
  username: process.env.RedditUsername,
  password: process.env.RedditPassword,
};

const client = new snoowrap(snoowrapConfig);
const BOT_START = Math.floor(Date.now() / 1000);
const processedCommentIds = new Set();
const updateQueue = [];

const subreddits = [
  "FreeGameFindings",
  "FreeGamesForPC",
  "testingground4bots",
  "FreeGamesForSteam",
  "FreeGamesOnSteam",
  "freegames",
  "Freegamestuff",
];

let processedLicenses = new Set();

logger.info("Bot is starting up and monitoring subreddits...");

async function pollSubreddits() {
  let delay = 20000; // 20 seconds default delay
  processedLicenses = new Set(); // Reset processed licenses for this cycle

  for (const subreddit of subreddits) {
    try {
      const comments = await client.getSubreddit(subreddit).getNewComments({ limit: 100 });
      for (const comment of comments) {
        processComment(comment, subreddit);
      }
    } catch (error) {
      logger.fetchError(subreddit, error);
      delay = 600000; // Switch to 10-minute delay on error
    }
  }
  setTimeout(pollSubreddits, delay);
}

function processComment(comment, subreddit) {
  if (comment.created_utc < BOT_START || processedCommentIds.has(comment.id)) return;

  processedCommentIds.add(comment.id);
  const licenseCommands = extractLicenseCommands(comment.body);
  const newLicenses = Array.from(licenseCommands).filter((license) => !processedLicenses.has(license));

  if (newLicenses.length > 0) {
    for (const license of newLicenses) {
      processedLicenses.add(license); // Mark these licenses as processed
    }
    const threadTitle = comment.link_title;  // Retrieve the thread title
    logger.processingComment(threadTitle, subreddit, newLicenses);
    enqueueUpdate(() => updateGist(newLicenses));
  }
}

function extractLicenseCommands(commentBody) {
  // Updated regex pattern to capture app/ and sub/ along with other prefixes
  const licensePattern = /(?:!?addlicense)\s+(?:asf\s+)?((?:[as]\/\d+|app\/\d+)(?:,\s*(?:[as]\/\d+|app\/\d+))*)/gi;
  const licenseCommands = new Set();
  let match = licensePattern.exec(commentBody);

  while (match !== null) {
    // Match the license and replace app/ with a/ and sub/ with s/
    let license = match[1].trim();
    // Replace `app/` with `a/` and `sub/` with `s/`
    license = license.replace(/\bapp\//g, 'a/').replace(/\bsub\//g, 's/');
    // Split by comma and add each license to the set
    const licenses = license.split(",");
    for (const license of licenses) {
      licenseCommands.add(license.trim()); // Add the license to the set after trimming whitespace
    }
    match = licensePattern.exec(commentBody); // Move to next match
  }

  return licenseCommands;
}

// Enqueue an update function to be processed one at a time
function enqueueUpdate(updateFunction) {
  updateQueue.push(updateFunction);
  if (updateQueue.length === 1) {
    processNextUpdate();
  }
}

// Process the next update in the queue
function processNextUpdate() {
  if (updateQueue.length > 0) {
    const updateFunction = updateQueue[0];
    updateFunction().finally(() => {
      updateQueue.shift();
      processNextUpdate();
    });
  }
}

async function updateGist(licenseCommands) {
  try {
    const gistId = process.env.gistId;
    const gist = await octokit.gists.get({ gist_id: gistId });
    const existingContent = gist.data.files["Steam Codes"].content.split("\n");
    const uniqueContent = mergeUniqueContent(existingContent, licenseCommands);

    if (uniqueContent.length === existingContent.length) {
      logger.noNewLicenses();
      return;
    }

    await updateGistContent(gistId, "Steam Codes", uniqueContent.join("\n"));
    await updateLatestGist(licenseCommands);
  } catch (error) {
    logger.gistUpdateError("Steam Codes", error);
    enqueueUpdate(() => updateGist(licenseCommands)); // Retry on error
  }
}

function mergeUniqueContent(existingContent, newContent) {
  return Array.from(new Set([...existingContent, ...newContent]));
}

async function updateLatestGist(licenseCommands) {
  try {
    const gistId = "2a611b12813fc06e17b89fcf00834e8c";
    const gist = await octokit.gists.get({ gist_id: gistId });
    const existingContent = gist.data.files["Latest Steam Games"].content.split("\n");
    let uniqueContent = mergeUniqueContent(existingContent, licenseCommands);

    if (uniqueContent.length > 40) {
      uniqueContent = uniqueContent.slice(-40); // Keep only the last 40 entries
    }

    if (uniqueContent.length !== existingContent.length || !uniqueContent.every((line, index) => line === existingContent[index])) {
      await updateGistContent(gistId, "Latest Steam Games", uniqueContent.join("\n"));
    }
  } catch (error) {
    logger.gistUpdateError("Latest Steam Games", error);
    enqueueUpdate(() => updateLatestGist(licenseCommands)); // Retry on error
  }
}

async function updateGistContent(gistId, filename, content) {
  await octokit.gists.update({ gist_id: gistId, files: { [filename]: { content } } });
  logger.gistUpdateSuccess(filename);
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.send("Bot is alive and running.");
});

// Start the Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Health check endpoint running on port ${PORT}`);
});

// Start polling subreddits
pollSubreddits();
