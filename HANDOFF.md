# Electrical Contract Web Tool: Handoff

One page for mentors and the programming team. State as of 2026-11-05.

## What it is

A web page where the electrical subteam records how each robot is wired: PDH and VRM
ports, breakers, wire gauge, power branches and the CAN daisy-chain order. Robot code
(the Java electrical contract) stays the source of truth for CAN IDs, channels and
motor types. The page shows those read-only, and students propose changes to them.

- **Site:** https://team488.github.io/electrical-contract-web/ (anyone can view; editing
  needs your name and the team passcode)
- **Full design and how-to:** `TeamXbot2026/plan_Ele_contract.md`. §12 covers day-to-day
  use, the passcode, deploying and local development. §11 lists open work and owners.

## Where everything lives

| Thing | Where |
|---|---|
| Front end | This repo, `web/`. GitHub Pages publishes it on every push to `main` |
| API and database | AWS account 851725533387, us-west-2, CloudFormation stack `ElectricalContractStack` (one Lambda behind a Function URL, one DynamoDB table) |
| Passcode and keys | AWS SSM Parameter Store: `/electrical-contract/PASSCODE`, `TOKEN_SECRET`, `SNAPSHOT_KEY` (plan §12.2) |
| AWS settings | `infra/cdk.json` |
| Java exporter (2026) | `TeamXbot2026/src/main/java/electrical/report/` |
| Java exporter (2027 on) | SeriouslyCommonLib PR #692 (`xbot.common.electrical.report`) |
| Snapshot workflow | `TeamXbot2026/.github/workflows/electrical-snapshots.yml`; for 2027 on, FRCRobotTemplate PR #96 |
| TeamXbot2025 one-off export | `scripts/legacy/teamxbot2025/` |

**AWS account owner: Alex is primary owner of account 851725533387, TBlank also has access. The
account is shared with the scouting app (`ScoutingBackendStack*`). Ask its owners
before running `cdk bootstrap` or adding an account-wide budget.

## What updates by itself, and what doesn't

- **TeamXbot2026 contracts:** automatic. Merging a contract change runs the
  *Electrical snapshots* Action, and the site picks it up within a few minutes.
- **Wiring entered on the web:** stays on the web. Code imports never overwrite it.
  Every change is in the History tab with who made it, and can be undone.
- **TeamXbot2025 robots:** a frozen one-off import (plan §13.7).
- **Backups:** DynamoDB point-in-time recovery, 35 days. The table is kept even if the
  stack is deleted.
- **Cost:** pennies a month (Lambda and DynamoDB on demand). No budget alert, because
  the account is shared.

## Unfinished, in order

1. **Review and merge TeamXbot2026 PR #432** (`ElectricalWeb`). Then change
   TeamXbot2026's entry in `snapshotSources` (`infra/cdk.json`) from `.../ElectricalWeb`
   to `.../main`, run `cdk deploy`, and delete the `ElectricalWeb` branch. Until then the
   site follows the `ElectricalWeb` branch.
2. **Before the 2027 repo is created** (plan §13.5, §13.6):
   - Review and merge FRCRobotTemplate PR #97. It moves the template to
     SeriouslyCommonLib `20261031.5` and fixes `Contract2023` for #688, which removed
     `CANBusId.RIO` and a `DeviceInfo` constructor. It's independent of the
     electrical work and builds cleanly now.
   - Review, merge and release SeriouslyCommonLib PR #692.
   - Rebase FRCRobotTemplate PR #96 on `main`, set `SeriouslyCommonLibVersion` to the
     #692 release, take it out of draft and merge. Its checks fail until #692 is on
     the library's `main`, because CI builds it against that.
   - Create the 2027 repo from the template, and add its snapshot folder to
     `snapshotSources`.
3. **Small data fixes** (plan §11):
   - Electrical: review the seeded wiring of the older robots, and check the
     wire-gauge table against the game manual.
   - Programming: remove the stale CAN ID 59, fix the `Contract2023` steering-motor
     names, and check why `Contract2025` turns every device off.

## Redeploying

- **Front end:** push to `main`.
- **API or infrastructure:** from a machine with the AWS CLI signed in to the account:
  ```powershell
  cd infra; npm install
  aws configure export-credentials --format powershell | Invoke-Expression
  npx cdk deploy
  ```
  Run `npx cdk diff` first if you're unsure what will change.

## If something goes wrong

| Symptom | Check |
|---|---|
| Page loads but shows no robots, or errors | Is the API up? Open `<ApiUrl>/api/robots` (the URL is `HOSTED_API` in `web/config.js`). Lambda logs: CloudWatch log group `ElectricalContractStack-ApiLogs*` |
| A Java change doesn't show | TeamXbot2026 Actions tab, *Electrical snapshots* run. Then the header's "Java <commit>". Manual fallback: `scripts/sync-contracts.ps1` (plan §12.3) |
| Nobody can log in | The passcode may have been changed without a redeploy (plan §12.2) |
| Bad edit | History tab → Undo. For bigger damage, DynamoDB point-in-time restore |
