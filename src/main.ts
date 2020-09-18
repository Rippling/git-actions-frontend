import * as core from "@actions/core";
import * as github from "@actions/github";
import _ from 'lodash';

const INNER_HTML_REGEX = /^\+.*(dangerouslySetInnerHTML|innerHTML).*$/gm;
const FILE_EXTENSION = /\.(jsx?|tsx?)$/;
const STYLE_FILE_EXTENSION = /\.(scss|css?)$/;
const ABSOLUTE_FILE_NAME_PATHS = ['package.json', 'package-lock.json']

async function run() {
  try {
    const token = core.getInput('access-token', {required: true});
    const org = core.getInput('org', { required: true });
    const coreReviewers = core.getInput('core-reviewers');
    const additionalReviewers = core.getInput('additional-reviewers');
    const reviewTeamSlug = core.getInput('review-team-slug', { required: true });

    if (!token || !org || !reviewTeamSlug) {
      core.debug('Please provide access-token, org and review-team-slug');
      return;
    }

    const teamName = `${_.capitalize(reviewTeamSlug)}-Team`;
    const client = new github.GitHub(token);

    console.log(`EVENT: ${github.context.eventName}`);
    if (github.context.eventName === 'push') {
      await handlePushEvent(client, teamName, coreReviewers, additionalReviewers, reviewTeamSlug);
      return;
    }

    if (github.context.eventName === 'pull_request_review') {
      await reTriggerFrontendCheck(client);
      return;
    }

    console.log('ERROR: Event not handled');
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function getReviewers(client: github.GitHub, reviewTeamSlug: string): Promise<string[]> {
  const team = await client.teams.getByName({
    org: github.context.repo.owner,
    team_slug: reviewTeamSlug,
  });
  if (!team) {
    return [];
  }
  const teamId = team.data.id;
  const members = await client.teams.listMembers({
    team_id: teamId,
  });
  return _.map(members.data, 'login');
}

async function getChangedFiles(
  client: github.GitHub,
  prNumber: number
) {
  const listFilesResponse = await client.pulls.listFiles({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber
  });
  return listFilesResponse.data;
}

function hasReviewableChanges(changedFiles): boolean {
  if (_.isEmpty(changedFiles)) {
    return false
  }
  return changedFiles.some(file => {
    const { filename } = file;
    return ABSOLUTE_FILE_NAME_PATHS.includes(filename) || STYLE_FILE_EXTENSION.test(file.filename) || _.includes(filename, 'app/modules/Common')
  });
}

function hasInnerHTMLAdded(changedFiles) {
  const innerHTMLAddedFiles: string[]  = [];

  if (_.isEmpty(changedFiles)) {
    return innerHTMLAddedFiles
  }

  changedFiles.forEach((file: Record<string, string>) => {
    if (file.patch && FILE_EXTENSION.test(file.filename) && INNER_HTML_REGEX.test(file.patch)) {
        innerHTMLAddedFiles.push(file.filename);
    }
  });

  if (innerHTMLAddedFiles.length) {
    console.log(`WARNING: innerHTML updated in following files ${innerHTMLAddedFiles.join(', ')}.`);
  }

  return innerHTMLAddedFiles;
}

async function addReviewers(client: github.GitHub, prNumber: number, coreReviewers: string) {
  const pullRequestResponse = await client.pulls.get({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber
  });

  console.log(`PR author: ${pullRequestResponse.data.user.login}`);
  const reviewers = _.filter(_.split(coreReviewers, ','), reviewer => reviewer !== pullRequestResponse.data.user.login);
  console.log(`Requesting review from: ${_.join(reviewers, ', ')}`);
  client.pulls.createReviewRequest({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber,
    reviewers: reviewers,
  })
}

// Re trigger event
async function reTriggerFrontendCheck(client: github.GitHub) {
  console.log('LOG: Finding Frontend Review Check');
  const pullRequest = github.context.payload.pull_request;
  if (pullRequest) {
    const headSHA = await getPullRequestHeadSHA(client, pullRequest.number);
    console.log(`LOG: Finding checks for PR: ${headSHA}`)
    const checkListResponse = await client.checks.listForRef({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      ref: headSHA,
    });
    console.log(`LOG: Found ${checkListResponse.data.check_runs.length} check runs.`)
    const reviewCheck = _.find(checkListResponse.data.check_runs, { name: 'FrontendReviewStatus' });
    if (reviewCheck) {
      console.log(`LOG: Re-triggering Review Check ${reviewCheck.name}`);
      try {
        await client.checks.rerequestSuite({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          check_suite_id: reviewCheck.check_suite.id
        });
      } catch (error) {
        console.log(error.message)
      }
    } else {
      console.log(checkListResponse.data.check_runs);
      core.setFailed('ERROR: No matching check found.');
    }
  } else {
    core.setFailed('ERROR: Pull request not found.');
  }
}
async function getPullRequestHeadSHA(client: github.GitHub, pull_number: number) {
  const pullRequestResponse = await client.pulls.get({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number
  });
  return pullRequestResponse.data.head.sha;
}
// PUSH EVENT HANDLING
async function handlePushEvent(client: github.GitHub, teamName: string, coreReviewers: string, additionalReviewers: string, reviewTeamSlug: string) {
  const pullRequest = await getPullRequestForSHA(client, github.context.sha);
  if (!pullRequest) {
    console.log('ERROR: Pull request not found.');
    return;
  }
  console.log(`PROCESSING: Fetching changed files for PR:#${pullRequest.number}`);
  const changedFiles = await getChangedFiles(client, pullRequest.number);
  const hasChangesInCommonFolder = hasReviewableChanges(changedFiles);
  const innerHTMLAddedFiles = hasInnerHTMLAdded(changedFiles).join(', ');

  if (hasChangesInCommonFolder || innerHTMLAddedFiles) {
    const isApproved = await checkApprovalForSHA(client, pullRequest.number, github.context.sha, additionalReviewers, reviewTeamSlug);
    if (isApproved) {
      console.log(`SUCCESS: ${teamName} approved changes.`);
    } else {
      await addReviewers(client, pullRequest.number, coreReviewers);
      innerHTMLAddedFiles ? core.setFailed(`ERROR: innerHTML is added/updated, ${teamName} approval needed`) : core.setFailed(`ERROR: ${teamName} approval needed`);
    }
  } else {
    console.log(`SUCCESS: No approval needed from ${teamName}.}`);
  }
}
async function getPullRequestForSHA(client: github.GitHub, commit_sha: string) {
  const pullRequests = await listPullRequestsAssociatedWithCommit(client, github.context.sha);
  const openPullRequests = _.filter(pullRequests, { state: 'open' });
  if (_.size(openPullRequests) > 1) {
    console.log(`WARNING: Multiple pull requests found for SHA: ${github.context.sha}.`)
  }
  return openPullRequests[0];
}
async function listPullRequestsAssociatedWithCommit(client: github.GitHub, commit_sha: string) {
  const apiResponse = await client.repos.listPullRequestsAssociatedWithCommit({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    commit_sha
  });
  return apiResponse.data;
}
async function checkApprovalForSHA(client: github.GitHub, pull_number: number, commit_sha: string, additionalReviewers: string, reviewTeamSlug: string): Promise<boolean> {
  console.log('STATUS: Checking approval status');
  const approvedLogins = await getApprovedReviewsForSHA(client, pull_number, commit_sha);
  const reviewTeamMembers: string[] = await getReviewers(client, reviewTeamSlug);
  if (_.intersection(approvedLogins, [...reviewTeamMembers, ..._.split(additionalReviewers, ',')]).length > 0) {
    return true;
  }
  return false;
}
async function getApprovedReviewsForSHA(client: github.GitHub, pull_number: number, commit_sha: string) {
  const apiResponse = await client.pulls.listReviews({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number
  });
  return _(apiResponse.data)
    .filter({ commit_id: commit_sha, state: 'APPROVED' })
    .map('user.login')
    .value();
}

run();
