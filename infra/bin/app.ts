// CDK app entry. Settings come from cdk.json "context"; override one with -c, e.g.
//   npx cdk deploy -c alertEmail=team@example.org
import { App } from "aws-cdk-lib";
import { ElectricalContractStack } from "../lib/stack.ts";

const app = new App();
const ctx = (key: string): string | undefined => {
  const v = app.node.tryGetContext(key);
  return v === undefined || v === null || v === "" ? undefined : String(v);
};

new ElectricalContractStack(app, "ElectricalContractStack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: ctx("region") ?? "us-west-2" },
  description: "Team 488 electrical contract web tool API",
  allowedOrigins: (ctx("allowedOrigins") ?? "https://team488.github.io").split(",").map((o) => o.trim()),
  ssmPrefix: ctx("ssmPrefix") ?? "/electrical-contract/",
  alertEmail: ctx("alertEmail"),
  monthlyBudgetUsd: Number(ctx("monthlyBudgetUsd") ?? 5),
  reservedConcurrency: ctx("reservedConcurrency") ? Number(ctx("reservedConcurrency")) : undefined,
  githubRepo: ctx("githubRepo"),
  createGithubOidcProvider: ctx("createGithubOidcProvider") !== "false",
  snapshotSource: ctx("snapshotSource"),
  snapshotPullMinutes: Number(ctx("snapshotPullMinutes") ?? 2),
});
