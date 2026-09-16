import type { Config } from "./config.js";

type AwsClientOptions = {
  region: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
};

/**
 * Local development uses the static credentials in .env. Deployed workloads
 * deliberately leave credentials to the AWS SDK default provider chain.
 */
export function createAwsClientOptions(config: Config): AwsClientOptions {
  if (!config.AWS_LOCAL) return { region: config.AWS_REGION };

  if (!config.AWS_ACCESS_KEY_ID || !config.AWS_SECRET_ACCESS_KEY) {
    throw new Error("Local AWS credentials are missing from configuration.");
  }

  return {
    region: config.AWS_REGION,
    credentials: {
      accessKeyId: config.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    },
  };
}
