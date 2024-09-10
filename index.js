import "dotenv/config";
import Snoowrap from "snoowrap";
import { Octokit } from "@octokit/rest";
import express from 'express';

// Custom log function with timestamp
function logWithTimestamp(message) {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: true });
  console.log(`[${timestamp}] ${message}`);
}

// Initialize Express app
const app = express();

// Octokit and Snoowrap configuration
const octokit = new Octokit({ auth: `token ${process.env.ghToken}` });

const snoowrapConfig = {
  userAgent: process.env.userAgent,
  clientId: process.env.clientId,
  clientSecret: process.env.clientSecret,
  username: process.env.RedditUsername,
  password: process.env.RedditPassword,
};

const client = new Snoowrap(snoowrapConfig);
const BOT_START = Date.now() / 1000;
const processedCommentIds = new Set();

const subreddits = [
  "FreeGameFindings",
  "FreeGamesForPC",
  "testingground4bots",
  "FreeGamesForSteam",
  "FreeGamesOnSteam",
  "freegames",
  "Freegamestuff",
];

const updateQueue = [];
let processedLicenses = new Set();

logWithTimestamp("Bot is starting up and monitoring subreddits...");

function pollSubreddits() {
  const delay = 20000; // 20 seconds
  processedLicenses = new Set(); // Reset processed licenses for this cycle

  Promise.all(subreddits.map(fetchAndProcessComments))
    .catch((error) => {
      logWithTimestamp(`Error fetching comments: ${error.message}`);
      setTimeout(pollSubreddits, 600000); // Switch to 10-minute delay on error
    })
    .finally(() => setTimeout(pollSubreddits, delay));
}

function fetchAndProcessComments(subreddit) {
  return client.getSubreddit(subreddit).getNewComments({ limit: 100 })
    .then((comments) => comments.forEach(processComment))
    .catch((error) => {
      logWithTimestamp(`Error fetching comments from subreddit ${subreddit}: ${error.message}`);
    });
}

function processComment(comment) {
  if (comment.created_utc < BOT_START || processedCommentIds.has(comment.id)) return;

  processedCommentIds.add(comment.id);
  const licenseCommands = extractLicenseCommands(comment.body);

  const newLicenses = Array.from(licenseCommands).filter((license) => !processedLicenses.has(license));

  if (newLicenses.length > 0) {
    newLicenses.forEach((license) => processedLicenses.add(license)); // Mark these licenses as processed
    logWithTimestamp(`Processing comment ID ${comment.id} with License ID's: ${newLicenses.join(', ')}`);
    enqueueUpdate(() => updateGist(newLicenses));
  }
}

function extractLicenseCommands(commentBody) {
  const licensePattern = /!addlicense\s+(?:asf\s+)?([as]\/[0-9]+(?:,[as]\/[0-9]+)*)/gi;
  const licenseCommands = new Set();
  let match;

  while ((match = licensePattern.exec(commentBody)) !== null) {
    match[1].split(',').forEach((license) => licenseCommands.add(license.trim()));
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
      logWithTimestamp("No new licenses added: All found licenses are already present.");
      return;
    }

    await updateGistContent(gistId, "Steam Codes", uniqueContent.join("\n"));
    await updateLatestGist(licenseCommands);
  } catch (error) {
    handleGistError(error, () => enqueueUpdate(() => updateGist(licenseCommands)), "Steam Codes");
  }
}

function mergeUniqueContent(existingContent, newContent) {
  const uniqueSet = new Set([...existingContent, ...newContent]);
  return Array.from(uniqueSet);
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
      logWithTimestamp("Gist updated with the latest 40 games.");
    } else {
      logWithTimestamp("No new unique licenses found for the latest Gist: Content is up-to-date.");
    }
  } catch (error) {
    handleGistError(error, () => enqueueUpdate(() => updateLatestGist(licenseCommands)), "Latest Steam Games");
  }
}

async function updateGistContent(gistId, filename, content) {
  try {
    await octokit.gists.update({ gist_id: gistId, files: { [filename]: { content } } });
    logWithTimestamp(`Gist content for ${filename} updated successfully.`);
  } catch (error) {
    throw error; // Re-throw to be caught by the caller
  }
}

function handleGistError(error, retryCallback, gistName) {
  if (error.status === 409) {
    logWithTimestamp(`Conflict error while updating Gist (${gistName}): ${error.message}. Retrying in 5 seconds...`);
    setTimeout(retryCallback, 5000); // Retry after 5 seconds
  } else {
    logWithTimestamp(`Error updating Gist (${gistName}): ${error.message}`);
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.send('Bot is alive and running.');
});

// Start the Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logWithTimestamp(`Health check endpoint running on port ${PORT}`);
});

// Start polling subreddits
pollSubreddits();
