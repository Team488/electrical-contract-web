# Electrical Contract Web Tool

Web version of Team 488's electrical contract report. Students view and edit the
robot's wiring in a browser:

- which PDH or VRM port powers each device
- breaker size and wire gauge
- power branches through converters
- the physical CAN daisy-chain order

The Java contract in the season robot repo (`TeamXbot2026`) stays the source of truth
for the fields the robot code uses (CAN IDs, channels, motor types). The web shows
those fields read-only, and students propose changes to them.

Design and phases: `TeamXbot2026/plan_electrical_web.md`.
Status: **phase 2 done (2026-10-31).** Live at https://team488.github.io/electrical-contract-web/
with the API on AWS (account 851725533387, us-west-2, stack `ElectricalContractStack`).
The local demo still works and uses a local API whenever the page is opened from
localhost or the LAN.

## Layout

```
api/      The API (TypeScript): handlers.ts (routes), dynamo-store.ts (DynamoDB),
          lambda.ts (AWS entry), local.ts (demo server) + tests
infra/    AWS CDK app (TypeScript): DynamoDB table, Lambda + Function URL, budget,
          GitHub OIDC deploy role
web/      Static front end: plain ES modules + vendored Preact/htm, no build step
scripts/  dev.ps1 (start the demo), get-dynamodb-local.ps1, import-snapshot.mjs, serve.py
```

## Run the local demo (Windows)

Needs Node 22+, Python 3 and Java 17+ (the WPILib JDK is found automatically). The
`-Snapshot` option also needs `../TeamXbot2026` checked out next to this folder.

```powershell
cd api; npm install; cd ..
./scripts/dev.ps1 -Snapshot      # first run: downloads DynamoDB Local, builds the 2026 snapshot, seeds the DB
```

Then open http://localhost:8000 and log in with the passcode in `api/.env` (created
from `api/.env.example` on first run). Ctrl+C stops everything.

| Option | Effect |
|---|---|
| `-Snapshot` | Re-run the Java exporter (`./gradlew electricalReport --args="--json"`) and import it |
| `-Reset` | Delete the local database first; the next import seeds wiring from the Java contract |
| `-Lan` | Listen on the network so phones and laptops on the same Wi-Fi can use it. Windows Firewall must allow ports 8000 and 8787 |

Ports: web 8000, API 8787, DynamoDB Local 8001 (data in `.local/dynamodb`).
DynamoDB Local is AWS's official local copy of DynamoDB, downloaded once into
`tools/dynamodb-local`.

## How the data fits together

- **Java changes arrive by themselves.** Each season repo's GitHub Action *Electrical
  snapshots* publishes every robot's contract as JSON to its `electrical-snapshots`
  branch on each merge. On page load, the API checks each repo's folder
  (`snapshotSources` in `infra/cdk.json`, comma-separated, at most every 2 minutes) and
  imports any new commit (`api/src/pull.ts`). `scripts/sync-contracts.ps1 -Repo owner/name`
  is the manual fallback.
- **One web robot per repo + contract.** The page picks a **Repository**, then a
  **Robot** (its `ContractToUse` name). The same contract name in two repos, e.g.
  `Competition` in TeamXbot2026 and in the 2027 repo, is two robots with separate wiring.
  Robots created before repos were tracked belong to `Team488/TeamXbot2026`.

- **One DynamoDB table** (`pk`/`sk`). Each robot's devices, ports, CAN chains and
  proposals share one partition (`ROBOT#1`), so one query loads the whole page.
  Snapshots and history have their own partitions. Layout: plan §4.
- **Snapshot import** (`POST /api/repos/<owner>/<repo>/contracts/<name>/snapshot`,
  guarded by `SNAPSHOT_KEY`; `/api/contracts/<name>/snapshot` means TeamXbot2026):
  - Stores the Java snapshot.
  - Keeps the device list in sync with code, keyed by `(bus, CAN ID)` or by DIO/PWM
    channel.
  - On the **first** import only, seeds the wiring from the contract's PDH, VRM,
    power-branch and CAN-order data. After that the web owns that data; later imports
    never overwrite it. Where code and wiring disagree, the Checks tab says so.
- **Edits** carry the row `version` they started from. Each save is one DynamoDB
  transaction: the row (only if the version still matches), a history entry and a
  revision bump. If someone saved first, nothing is written, the API returns 409,
  and the page shows their change with a choice to keep theirs or overwrite.
- **History** logs every change with who made it. Undo writes the old values back as
  a new change.
- Pages poll a revision number every 10 s and refresh when it changes.
- **Checks** run in the browser (`web/validate.js`); **Print / PDF** is
  `web/print.html`.

## Tests

```powershell
cd api;   npm test; npm run typecheck   # 26 API tests against an in-memory DynamoDB Local
cd infra; npm test; npm run typecheck   # 5 CDK template tests
```

## Deploying to AWS (how phase 2 was done; repeat to update)

All settings are in `infra/cdk.json` (`context`); override with `-c key=value`.

1. A mentor opens the AWS account (team email, MFA on root), creates a deploy user in
   IAM Identity Center, and runs `aws configure sso`.
2. Create the secrets (CDK can't create SecureStrings):
   ```powershell
   aws ssm put-parameter --type SecureString --name /electrical-contract/PASSCODE     --value <passcode>
   aws ssm put-parameter --type SecureString --name /electrical-contract/TOKEN_SECRET --value <long random string>
   aws ssm put-parameter --type SecureString --name /electrical-contract/SNAPSHOT_KEY --value <random string>
   ```
3. Deploy:
   ```powershell
   cd infra; npm install
   npx cdk bootstrap aws://<account-id>/us-west-2
   npx cdk deploy -c alertEmail=<team email>
   ```
   Add `-c reservedConcurrency=5` if the account's Lambda concurrency quota allows it.
   Add `-c createGithubOidcProvider=false` if the account already has a GitHub OIDC
   provider.
4. Put the `ApiUrl` output (without the trailing slash) in `HOSTED_API` in
   `web/config.js` and push to `main`. The Pages workflow
   (`.github/workflows/pages.yml`) publishes `web/`.
5. Import the snapshot:
   `$env:SNAPSHOT_KEY='<key>'; node scripts/import-snapshot.mjs <snapshot.json> <ApiUrl>`.

The CLI credentials from `aws login` aren't read by CDK directly; before `cdk deploy`,
load them into the shell with
`aws configure export-credentials --format powershell | Invoke-Expression`.

The team passcode is in SSM. Read it with
`aws ssm get-parameter --with-decryption --name /electrical-contract/PASSCODE --query Parameter.Value --output text`.
To change it, `put-parameter --overwrite` a new value. The API reads secrets at cold
start, so redeploy (or wait for idle instances to recycle) for a change to take effect.
