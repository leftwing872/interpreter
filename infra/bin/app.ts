import { App } from "aws-cdk-lib";
import { InterpreterStack } from "../lib/interpreter-stack.js";

const app = new App();

// Deploy region is pinned to Seoul regardless of the shell's AWS_REGION.
// Override with: cdk deploy -c region=us-east-1
const region: string = app.node.tryGetContext("region") ?? "ap-northeast-2";

new InterpreterStack(app, "InterpreterStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: "Live interpreter: Transcribe streaming + Bedrock Claude translation (ECS Fargate + CloudFront)",
  // Optional: -c domainName=interp.example.com -c certificateArn=arn:aws:acm:us-east-1:...  (cert must be in us-east-1)
  domainName: app.node.tryGetContext("domainName"),
  certificateArn: app.node.tryGetContext("certificateArn"),
  bedrockModelId: app.node.tryGetContext("bedrockModelId") ?? "global.anthropic.claude-opus-5-5",
  bedrockFallbackModelId: app.node.tryGetContext("bedrockFallbackModelId") ?? "global.anthropic.claude-haiku-5-5",
  // Bedrock defaults to the same region (global inference profile is available in Seoul).
  bedrockRegion: app.node.tryGetContext("bedrockRegion") ?? region,
});
