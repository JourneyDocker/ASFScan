import "dotenv/config";
import Snoowrap from "snoowrap";
import { Octokit } from "@octokit/rest";

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

console.log("Bot is starting up and monitoring subreddits...");

function pollSubreddits() {
  const delay = 20000; // 20 seconds
  console.log("Polling subreddits for new comments...");

  Promise.all(subreddits.map(fetchAndProcessComments))
    .catch((error) => {
      console.error(`Error fetching comments: ${error.message}`);
      setTimeout(pollSubreddits, 600000); // Switch to 10-minute delay on error
    })
    .finally(() => setTimeout(pollSubreddits, delay));
}

function fetchAndProcessComments(subreddit) {
  return client.getSubreddit(subreddit).getNewComments({ limit: 100 })
    .then((comments) => comments.forEach(processComment))
    .catch((error) => {
      console.error(`Error fetching comments from subreddit ${subreddit}: ${error.message}`);
    });
}

function processComment(comment) {
  if (comment.created_utc < BOT_START || processedCommentIds.has(comment.id)) return;

  processedCommentIds.add(comment.id);
  const licenseCommands = extractLicenseCommands(comment.body);

  if (licenseCommands.size > 0) {
    console.log(`Processing comment ID ${comment.id} with License ID's: ${Array.from(licenseCommands).join(', ')}`);
    updateGist(Array.from(licenseCommands));
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

async function updateGist(licenseCommands) {
  try {
    const gistId = process.env.gistId;
    const gist = await octokit.gists.get({ gist_id: gistId });
    const existingContent = gist.data.files["Steam Codes"].content.split("\n");
    const uniqueContent = mergeUniqueContent(existingContent, licenseCommands);

    if (uniqueContent.length === existingContent.length) {
      console.log("No new licenses added: All found licenses are already present.");
      return;
    }

    await updateGistContent(gistId, "Steam Codes", uniqueContent.join("\n"));
    //console.log(`Gist updated with new licenses: ${licenseCommands.join(', ')}`);
    await updateLatestGist(licenseCommands);
  } catch (error) {
    handleGistError(error, () => updateGist(licenseCommands), "Steam Codes");
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
    const uniqueContent = mergeUniqueContent(existingContent, licenseCommands);

    if (uniqueContent.length > 40) {
      uniqueContent.splice(0, uniqueContent.length - 40); // Keep only the last 40 entries
    }

    if (uniqueContent.length === existingContent.length) {
      console.log("No new unique licenses found for the latest Gist: Content is up-to-date.");
      return;
    }

    await updateGistContent(gistId, "Latest Steam Games", uniqueContent.join("\n"));
    //console.log("Gist updated with the latest 40 games.");
  } catch (error) {
    handleGistError(error, () => updateLatestGist(licenseCommands), "Latest Steam Games");
  }
}

async function updateGistContent(gistId, filename, content) {
  try {
    await octokit.gists.update({ gist_id: gistId, files: { [filename]: { content } } });
    console.log(`Gist content for ${filename} updated successfully.`);
  } catch (error) {
    console.error(`Failed to update Gist content for ${filename}: ${error.message}`);
    throw error; // Re-throw to be caught by the caller
  }
}

function handleGistError(error, retryCallback, gistName) {
  console.error(`Error updating Gist (${gistName}): ${error.message}`);

  if (error.status === 409) {
    console.log("Conflict error encountered; retrying update in 5 seconds...");
    setTimeout(retryCallback, 5000); // Retry after 5 seconds
  }
}

pollSubreddits();
