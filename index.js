import "dotenv/config";
import Snoowrap from "snoowrap";
import { Octokit } from "@octokit/rest";

const octokit = new Octokit({
  auth: `token ${process.env.ghToken}`,
});

const creds = {
  userAgent: process.env.userAgent,
  clientId: process.env.clientId,
  clientSecret: process.env.clientSecret,
  username: process.env.RedditUsername,
  password: process.env.RedditPassword,
};

// Build Snoowrap client
const client = new Snoowrap(creds);
const BOT_START = Date.now() / 1000;
const ids = [];

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

function checkForComments() {
  let delay = 20000; // 20 seconds

  console.log("Polling subreddits for new comments...");

  subreddits.forEach((subreddit) => {
    client
      .getSubreddit(subreddit)
      .getNewComments({ limit: 100 })
      .then((comments) => {
        comments.forEach((comment) => {
          handleComment(comment);
        });
      })
      .catch((error) => {
        console.error(`Error fetching comments from subreddit ${subreddit}: ${error.message}`);
        console.log("Switching to 10-minute delay due to error.");
        delay = 600000; // 10 minutes
      });
  });

  setTimeout(checkForComments, delay);
}

checkForComments();

function handleComment(comment) {
  if (!ids.includes(comment.id)) {
    ids.push(comment.id);
    handleMessage(comment);
  }
}

function handleMessage(comment) {
  if (comment.created_utc < BOT_START) {
    //console.log(`Skipping old comment ID ${comment.id}`);
    return;
  }

  const licensePattern = /!addlicense\s+ASF\s+([as])\/([0-9,]+)/gi;
  let matchLicense;
  const licenseCommands = new Set();

  while ((matchLicense = licensePattern.exec(comment.body)) !== null) {
    const licenseType = matchLicense[1];
    const licenseIds = matchLicense[2].split(',');

    // Extracting only the `a/{numbers}` or `s/{numbers}` part
    const asfMsgs = licenseIds.map(id => `${licenseType}/${id}`);
    asfMsgs.forEach(asfMsg => licenseCommands.add(asfMsg));
  }

  if (licenseCommands.size > 0) {
    console.log(`Found commands in comment ID ${comment.id}: ${Array.from(licenseCommands).join(', ')}`);
    updateGist(Array.from(licenseCommands));
  } else {
    //console.log(`No valid license commands found in comment ID ${comment.id}`);
  }
}

async function updateGist(asfMsgs) {
  try {
    const gist = await octokit.gists.get({ gist_id: process.env.gistId });
    const existingContent = gist.data.files["Steam Codes"].content.split("\n");

    // Filter out duplicate licenses
    const uniqueMsgs = new Set([...existingContent, ...asfMsgs]);
    if (uniqueMsgs.size === existingContent.length) {
      console.log("Duplicate licenses detected; no new entries added.");
      return;
    }

    // Combine existing and new licenses, ensuring uniqueness
    const newContent = Array.from(uniqueMsgs).join("\n");

    // Update the main Gist with unique values only
    await updateGistContent(process.env.gistId, "Steam Codes", newContent);
    console.log(`Successfully updated Gist with new licenses: ${asfMsgs.join(', ')}`);

    // Updating the gist for the latest 40 games, with duplicate check
    await updateLatestGist(asfMsgs);
  } catch (error) {
    console.error(`Error updating Gist: ${error.message}`);

    // Retry logic for 409 Conflict
    if (error.status === 409) {
      console.log("Conflict error encountered; retrying update in 5 seconds...");
      setTimeout(() => updateGist(asfMsgs), 5000); // Retry after 5 seconds
    }
  }
}

async function updateGistContent(gistId, filename, newContent) {
  try {
    await octokit.gists.update({
      gist_id: gistId,
      files: {
        [filename]: {
          content: newContent,
        },
      },
    });
    console.log(`Gist content for ${filename} updated successfully.`);
  } catch (error) {
    console.error(`Failed to update Gist content for ${filename}: ${error.message}`);
    throw error; // Re-throw the error to be caught by the caller
  }
}

async function updateLatestGist(asfMsgs) {
  try {
    const gist = await octokit.gists.get({ gist_id: "2a611b12813fc06e17b89fcf00834e8c" });
    const existingContent = gist.data.files["Latest Steam Games"].content.split("\n");

    // Filter out duplicate licenses
    const uniqueMsgs = new Set([...existingContent, ...asfMsgs]);
    if (uniqueMsgs.size === existingContent.length) {
      console.log("No new unique licenses found for the latest Gist.");
      return;
    }

    // Combine existing and new licenses, ensuring uniqueness and limit to 40 entries
    let newContent = Array.from(uniqueMsgs).join("\n");
    const lines = newContent.split("\n");
    if (lines.length > 40) {
      newContent = lines.slice(lines.length - 40).join("\n");
    }

    // Update the Gist with the latest 40 unique licenses
    await updateGistContent("2a611b12813fc06e17b89fcf00834e8c", "Latest Steam Games", newContent);
    console.log("Successfully updated Gist with the latest 40 games.");
  } catch (error) {
    console.error(`Error updating the latest Gist: ${error.message}`);

    // Retry logic for 409 Conflict
    if (error.status === 409) {
      console.log("Conflict error encountered while updating latest Gist; retrying in 5 seconds...");
      setTimeout(() => updateLatestGist(asfMsgs), 5000); // Retry after 5 seconds
    }
  }
}
