// Where the API lives. Opened from this machine or the LAN (local demo, scripts/dev.ps1):
// the API on port 8787 of the same host. Anywhere else (GitHub Pages): the Lambda
// Function URL printed by `cdk deploy` as ApiUrl, without the trailing slash.
const HOSTED_API = "https://iqzxovxrrtmrmj7luwdtc457c40lyehm.lambda-url.us-west-2.on.aws";
const isLocal = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);

export const API_BASE = isLocal ? `${location.protocol}//${location.hostname}:8787` : HOSTED_API;
/** Robot shown on a first visit; the header picker switches robots after that. */
export const ROBOT_ID = 1;
export const POLL_SECONDS = 10;
