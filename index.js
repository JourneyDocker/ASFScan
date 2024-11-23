import "dotenv/config";
import snoowrap from "snoowrap";
import { Octokit } from "@octokit/rest";
import express from "express";
import logger from "./lib/logger.js"; // Custom logger module

const app = express();

// Configure GitHub and Reddit clients
const octokit = new Octokit({ auth: `token ${process.env.ghToken}` });
const snoowrapConfig = {
  userAgent: process.env.userAgent,
  clientId: process.env.clientId,
  clientSecret: process.env.clientSecret,
  username: process.env.RedditUsername,
  password: process.env.RedditPassword,
};
const client = new snoowrap(snoowrapConfig);

const BOT_START = Math.floor(Date.now() / 1000); // Bot start timestamp
const processedCommentIds = new Set(); // Track processed comments
const updateQueue = []; // Queue for sequential Gist updates
const subreddits = [
  "FreeGameFindings",
  "FreeGamesForPC",
  "testingground4bots",
  "FreeGamesForSteam",
  "FreeGamesOnSteam",
  "freegames",
  "Freegamestuff",
];

let processedLicenses = new Set(); // Track processed licenses

logger.info("Bot started and monitoring subreddits...");

// Poll subreddits for new comments
async function pollSubreddits() {
  let delay = 20000; // Default delay: 20 seconds
  processedLicenses.clear(); // Reset processed licenses

  for (const subreddit of subreddits) {
    try {
      const comments = await client.getSubreddit(subreddit).getNewComments({ limit: 100 });
      comments.forEach((comment) => processComment(comment, subreddit));
    } catch (error) {
      logger.fetchError(subreddit, error);
      delay = 600000; // Increase delay to 10 minutes on error
    }
  }

  setTimeout(pollSubreddits, delay);
}

// Process a comment for license commands
function processComment(comment, subreddit) {
  if (comment.created_utc < BOT_START || processedCommentIds.has(comment.id)) return;

  processedCommentIds.add(comment.id);
  const licenseCommands = extractLicenseCommands(comment.body);
  const newLicenses = Array.from(licenseCommands).filter((license) => !processedLicenses.has(license));

  if (newLicenses.length > 0) {
    newLicenses.forEach((license) => processedLicenses.add(license));
    logger.processingComment(comment.link_title, subreddit, newLicenses);
    enqueueUpdate(() => updateGist(newLicenses));
  }
}

// Extract license commands from comment body
function extractLicenseCommands(commentBody) {
  const licensePattern = /(?:!?addlicense)\s+(?:asf\s+)?((?:[as]\/\d+|app\/\d+)(?:,\s*(?:[as]\/\d+|app\/\d+))*)/gi;
  const licenseCommands = new Set();

  let match;
  while ((match = licensePattern.exec(commentBody)) !== null) {
    match[1]
      .trim()
      .replace(/\bapp\//g, 'a/')
      .replace(/\bsub\//g, 's/')
      .split(",")
      .forEach((license) => licenseCommands.add(license.trim()));
  }

  return licenseCommands;
}

// Add update functions to the queue
function enqueueUpdate(updateFunction) {
  updateQueue.push(updateFunction);
  if (updateQueue.length === 1) processNextUpdate();
}

// Process updates sequentially
function processNextUpdate() {
  if (updateQueue.length > 0) {
    const updateFunction = updateQueue[0];
    updateFunction().finally(() => {
      updateQueue.shift();
      processNextUpdate();
    });
  }
}

// Update the main "Steam Codes" Gist
async function updateGist(licenseCommands) {
  try {
    const gistId = process.env.gistId;
    const gist = await octokit.gists.get({ gist_id: gistId });
    const existingContent = gist.data.files["Steam Codes"].content.split("\n");
    const updatedContent = mergeUniqueContent(existingContent, licenseCommands);

    if (hasContentChanged(existingContent, updatedContent)) {
      await updateGistContent(gistId, "Steam Codes", updatedContent.join("\n"));
      await updateLatestGist(licenseCommands);
    } else {
      logger.noNewLicenses();
    }
  } catch (error) {
    logger.gistUpdateError("Steam Codes", error);
    enqueueUpdate(() => updateGist(licenseCommands));
  }
}

// Merge new licenses with existing content
function mergeUniqueContent(existingContent, newContent) {
  return [...existingContent.filter((line) => !newContent.includes(line)), ...newContent];
}

// Check if content has changed
function hasContentChanged(existingContent, updatedContent) {
  return (
    existingContent.length !== updatedContent.length ||
    !existingContent.every((line, index) => line === updatedContent[index])
  );
}

// Update the "Latest Steam Games" Gist with recent licenses
async function updateLatestGist(licenseCommands) {
  try {
    const gistId = "2a611b12813fc06e17b89fcf00834e8c";
    const gist = await octokit.gists.get({ gist_id: gistId });
    const existingContent = gist.data.files["Latest Steam Games"].content.split("\n");
    let updatedContent = mergeUniqueContent(existingContent, licenseCommands);

    if (updatedContent.length > 40) updatedContent = updatedContent.slice(-40); // Keep last 40 entries

    if (hasContentChanged(existingContent, updatedContent)) {
      await updateGistContent(gistId, "Latest Steam Games", updatedContent.join("\n"));
    }
  } catch (error) {
    logger.gistUpdateError("Latest Steam Games", error);
    enqueueUpdate(() => updateLatestGist(licenseCommands));
  }
}

// Update content of a specific Gist file
async function updateGistContent(gistId, filename, content) {
  await octokit.gists.update({ gist_id: gistId, files: { [filename]: { content } } });
  logger.gistUpdateSuccess(filename);
}

// Health check endpoint
app.get("/health", (req, res) => res.send("Bot is alive and running."));

// Start server and begin polling
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`Health check endpoint running on port ${PORT}`));

pollSubreddits();
