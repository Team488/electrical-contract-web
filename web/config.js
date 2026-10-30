// Where the API lives. Local demo: the API runs on port 8787 of the same machine that
// serves this page, so LAN devices work too. On AWS: the Lambda Function URL printed by
// `cdk deploy` (ApiUrl output), without the trailing slash.
export const API_BASE = `${location.protocol}//${location.hostname}:8787`;
export const ROBOT_ID = 1;
export const POLL_SECONDS = 10;
