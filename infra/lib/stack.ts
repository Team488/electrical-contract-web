// Everything the electrical contract API needs on AWS (plan §7): DynamoDB table, Lambda
// behind a Function URL, SSM secret access, log retention, a budget alert, and an
// optional GitHub Actions deploy role (OIDC, no stored AWS keys).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Arn, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps,
  aws_budgets as budgets, aws_dynamodb as dynamodb, aws_iam as iam, aws_lambda as lambda,
  aws_lambda_nodejs as nodejs, aws_logs as logs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface ElectricalContractStackProps extends StackProps {
  /** Browser origins allowed to call the API (GitHub Pages, plus localhost for testing). */
  allowedOrigins: string[];
  /** SSM parameter path holding PASSCODE, TOKEN_SECRET and SNAPSHOT_KEY, e.g. "/electrical-contract/". */
  ssmPrefix: string;
  /** Email for the monthly budget alert; no budget is created without it. */
  alertEmail?: string;
  monthlyBudgetUsd: number;
  /** Cap on simultaneous Lambda instances; leave unset if the account's quota is too low to reserve any. */
  reservedConcurrency?: number;
  /** "owner/repo" allowed to deploy from GitHub Actions on main; no role is created without it. */
  githubRepo?: string;
  /** Create the account's GitHub OIDC provider (false if another stack already made it). */
  createGithubOidcProvider: boolean;
  /** Folder URL of published contract snapshots (index.json + one file per robot); unset = no pulling. */
  snapshotSource?: string;
  /** Minutes between checks of snapshotSource, per API instance. */
  snapshotPullMinutes: number;
}

export class ElectricalContractStack extends Stack {
  constructor(scope: Construct, id: string, props: ElectricalContractStackProps) {
    super(scope, id, props);

    const table = new dynamodb.TableV2(this, "Table", {
      tableName: "electrical-contract",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // The wiring data outlives the stack: `cdk destroy` leaves the table in place.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const logGroup = new logs.LogGroup(this, "ApiLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const api = new nodejs.NodejsFunction(this, "Api", {
      entry: join(repoRoot, "api", "src", "lambda.ts"),
      handler: "handler",
      projectRoot: join(repoRoot, "api"),
      depsLockFilePath: join(repoRoot, "api", "package-lock.json"),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // A snapshot pull imports every robot inside one request, so allow more than a plain read needs.
      timeout: Duration.seconds(30),
      logGroup,
      reservedConcurrentExecutions: props.reservedConcurrency,
      environment: {
        TABLE_NAME: table.tableName,
        SSM_PREFIX: props.ssmPrefix,
        ...(props.snapshotSource ? { SNAPSHOT_SOURCE: props.snapshotSource } : {}),
        SNAPSHOT_PULL_MINUTES: String(props.snapshotPullMinutes),
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        target: "node22",
        minify: true,
        sourceMap: true,
        // The Lambda runtime already includes AWS SDK v3.
        externalModules: ["@aws-sdk/*"],
      },
    });
    table.grantReadWriteData(api);
    api.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ssm:GetParameters"],
      resources: [Arn.format({ service: "ssm", resource: "parameter", resourceName: `${props.ssmPrefix.replace(/^\//, "")}*` }, this)],
    }));

    // The API checks its own passcode tokens, so the URL itself is public.
    const url = api.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: props.allowedOrigins,
        allowedMethods: [lambda.HttpMethod.ALL],
        allowedHeaders: ["authorization", "content-type", "x-snapshot-key"],
        maxAge: Duration.days(1),
      },
    });
    new CfnOutput(this, "ApiUrl", { value: url.url, description: "Set API_BASE in web/config.js to this (without the trailing slash)" });

    if (props.alertEmail) {
      new budgets.CfnBudget(this, "MonthlyBudget", {
        budget: {
          budgetName: "electrical-contract-monthly",
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: props.monthlyBudgetUsd, unit: "USD" },
        },
        notificationsWithSubscribers: [
          { notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 80, thresholdType: "PERCENTAGE" },
            subscribers: [{ subscriptionType: "EMAIL", address: props.alertEmail }] },
          { notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" },
            subscribers: [{ subscriptionType: "EMAIL", address: props.alertEmail }] },
        ],
      });
    }

    if (props.githubRepo) {
      const issuer = "token.actions.githubusercontent.com";
      const provider = props.createGithubOidcProvider
        ? new iam.OpenIdConnectProvider(this, "GitHubOidc", { url: `https://${issuer}`, clientIds: ["sts.amazonaws.com"] })
        : iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, "GitHubOidc",
            Arn.format({ service: "iam", region: "", resource: "oidc-provider", resourceName: issuer }, this));
      const role = new iam.Role(this, "GitHubDeployRole", {
        roleName: "electrical-contract-github-deploy",
        description: `cdk deploy from GitHub Actions on ${props.githubRepo} main`,
        maxSessionDuration: Duration.hours(1),
        assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
          StringEquals: {
            [`${issuer}:aud`]: "sts.amazonaws.com",
            [`${issuer}:sub`]: `repo:${props.githubRepo}:ref:refs/heads/main`,
          },
        }),
      });
      // cdk deploy works by assuming the roles `cdk bootstrap` created; that's all this role needs.
      role.addToPolicy(new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [Arn.format({ service: "iam", region: "", resource: "role", resourceName: "cdk-*" }, this)],
      }));
      new CfnOutput(this, "GitHubDeployRoleArn", { value: role.roleArn, description: "role-to-assume for aws-actions/configure-aws-credentials" });
    }
  }
}
