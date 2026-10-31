import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { expect, it } from "vitest";
import { ElectricalContractStack, type ElectricalContractStackProps } from "../lib/stack.ts";

const base: ElectricalContractStackProps = {
  env: { region: "us-west-2" },
  allowedOrigins: ["https://team488.github.io"],
  ssmPrefix: "/electrical-contract/",
  monthlyBudgetUsd: 5,
  createGithubOidcProvider: true,
  snapshotPullMinutes: 2,
};

function synth(extra: Partial<ElectricalContractStackProps> = {}) {
  return Template.fromStack(new ElectricalContractStack(new App(), "Test", { ...base, ...extra }));
}

it("keeps the table, with point-in-time recovery, on-demand billing and pk/sk keys", () => {
  const t = synth();
  t.hasResource("AWS::DynamoDB::GlobalTable", {
    DeletionPolicy: "Retain",
    Properties: Match.objectLike({
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
      Replicas: [Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })],
    }),
  });
});

it("runs the API on Node 22 arm64 behind a public Function URL with CORS for Pages", () => {
  const t = synth();
  t.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs22.x", Architectures: ["arm64"],
    Environment: { Variables: Match.objectLike({ SSM_PREFIX: "/electrical-contract/" }) },
  });
  t.hasResourceProperties("AWS::Lambda::Url", {
    AuthType: "NONE",
    Cors: Match.objectLike({ AllowOrigins: ["https://team488.github.io"] }),
  });
  t.resourceCountIs("AWS::Lambda::Permission", 2);
  t.hasResourceProperties("AWS::Lambda::Function", { Timeout: 30 });
  t.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 30 });
});

it("passes the snapshot source to the API only when set", () => {
  const vars = (t: Template) =>
    Object.values(t.findResources("AWS::Lambda::Function"))[0].Properties.Environment.Variables;
  expect(vars(synth())).not.toHaveProperty("SNAPSHOT_SOURCE");
  expect(vars(synth({ snapshotSource: "https://example/snaps" }))).toMatchObject({
    SNAPSHOT_SOURCE: "https://example/snaps", SNAPSHOT_PULL_MINUTES: "2",
  });
});

it("lets the API read only its own SSM parameters", () => {
  const policies = synth().findResources("AWS::IAM::Policy");
  const text = JSON.stringify(policies);
  expect(text).toContain("ssm:GetParameters");
  expect(text).toContain(":parameter/electrical-contract/*");
});

it("adds the budget only with an email, and the deploy role only with a repo", () => {
  synth().resourceCountIs("AWS::Budgets::Budget", 0);
  synth().resourceCountIs("AWS::IAM::Role", 1); // just the Lambda role
  const t = synth({ alertEmail: "team@example.org", githubRepo: "Team488/electrical-contract-web", reservedConcurrency: 5 });
  t.hasResourceProperties("AWS::Budgets::Budget", { Budget: Match.objectLike({ BudgetLimit: { Amount: 5, Unit: "USD" } }) });
  t.hasResourceProperties("AWS::Lambda::Function", { ReservedConcurrentExecutions: 5 });
  t.hasResourceProperties("AWS::IAM::Role", {
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: [Match.objectLike({
        Condition: { StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:Team488/electrical-contract-web:ref:refs/heads/main",
        } },
      })],
    }),
  });
});
