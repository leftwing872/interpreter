import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CfnOutput, Duration, RemovalPolicy, Stack, type StackProps,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_ec2 as ec2,
  aws_ecr_assets as ecr_assets,
  aws_ecs as ecs,
  aws_ecs_patterns as patterns,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

export interface InterpreterStackProps extends StackProps {
  bedrockModelId: string;
  bedrockFallbackModelId: string;
  bedrockRegion: string;
  domainName?: string;
  certificateArn?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

export class InterpreterStack extends Stack {
  constructor(scope: Construct, id: string, props: InterpreterStackProps) {
    super(scope, id, props);

    // ---- Network -------------------------------------------------------------
    // Public subnets only: the task runs with a public IP and reaches AWS APIs
    // over the internet, which avoids NAT gateway cost for a small service.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC }],
    });

    // ---- Shared access token (auto-generated) --------------------------------
    const accessToken = new secretsmanager.Secret(this, "AccessToken", {
      description: "Shared access token for the interpreter UI",
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---- ECS Fargate + ALB -----------------------------------------------------
    const cluster = new ecs.Cluster(this, "Cluster", { vpc, containerInsightsV2: ecs.ContainerInsights.ENABLED });

    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const service = new patterns.ApplicationLoadBalancedFargateService(this, "Service", {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 1,
      assignPublicIp: true,
      taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      publicLoadBalancer: true,
      openListener: false, // ingress is granted to the CloudFront prefix list only (below)
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset(path.join(here, "..", ".."), {
          platform: ecr_assets.Platform.LINUX_ARM64,
        }),
        containerPort: 3000,
        environment: {
          NODE_ENV: "production",
          PORT: "3000",
          BEDROCK_MODEL_ID: props.bedrockModelId,
          BEDROCK_FALLBACK_MODEL_ID: props.bedrockFallbackModelId,
          BEDROCK_REGION: props.bedrockRegion,
          TRANSLATE_EFFORT: "low",
        },
        secrets: { ACCESS_TOKEN: ecs.Secret.fromSecretsManager(accessToken) },
        logDriver: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "app" }),
      },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    service.targetGroup.configureHealthCheck({
      path: "/health",
      interval: Duration.seconds(30),
      healthyThresholdCount: 2,
    });
    // WebSocket sessions are long-lived; the browser sends audio every 100 ms so
    // the connection never idles, but give slack for pauses.
    service.loadBalancer.setAttribute("idle_timeout.timeout_seconds", "300");
    service.targetGroup.setAttribute("deregistration_delay.timeout_seconds", "30");

    // ---- IAM for the app -------------------------------------------------------
    const taskRole = service.taskDefinition.taskRole;
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: "TranscribeStreaming",
      actions: ["transcribe:StartStreamTranscription"],
      resources: ["*"], // Transcribe streaming has no resource-level permissions
    }));
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: "BedrockClaude",
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: [
        `arn:aws:bedrock:*::foundation-model/anthropic.*`,
        `arn:aws:bedrock:*:${this.account}:inference-profile/*anthropic.*`,
      ],
    }));

    // ---- CloudFront (HTTPS + WebSocket passthrough) ---------------------------
    // Browsers only allow microphone / screen capture on HTTPS. CloudFront gives
    // us TLS with no custom domain required, and proxies WebSocket upgrades.
    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, "Certificate", props.certificateArn)
      : undefined;

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "Live interpreter",
      domainNames: props.domainName ? [props.domainName] : undefined,
      certificate,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(service.loadBalancer, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          readTimeout: Duration.seconds(60),
          keepaliveTimeout: Duration.seconds(60),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
    });

    // Only CloudFront may reach the ALB (prevents bypassing TLS and the token check path).
    const cloudFrontPrefixList = ec2.PrefixList.fromLookup(this, "CloudFrontPrefixList", {
      prefixListName: "com.amazonaws.global.cloudfront.origin-facing",
    });
    service.loadBalancer.connections.allowFrom(
      ec2.Peer.prefixList(cloudFrontPrefixList.prefixListId),
      ec2.Port.tcp(80),
      "CloudFront origin-facing",
    );

    // ---- Outputs ---------------------------------------------------------------
    new CfnOutput(this, "Url", {
      value: props.domainName ? `https://${props.domainName}` : `https://${distribution.distributionDomainName}`,
    });
    new CfnOutput(this, "CloudFrontDomain", { value: distribution.distributionDomainName });
    new CfnOutput(this, "AccessTokenSecretArn", { value: accessToken.secretArn });
    new CfnOutput(this, "GetAccessTokenCommand", {
      value: `aws secretsmanager get-secret-value --secret-id ${accessToken.secretArn} --query SecretString --output text --region ${this.region}`,
    });
    new CfnOutput(this, "LogGroup", { value: logGroup.logGroupName });
    new CfnOutput(this, "ServiceName", { value: service.service.serviceName });
    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });
  }
}
