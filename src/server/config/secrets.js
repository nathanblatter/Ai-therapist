import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import "dotenv/config";

// The OpenAI key (used for the Realtime API) is stored in AWS Secrets Manager.
// AWS credentials are supplied to the container via AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY / AWS_REGION.
export async function getOpenAIKey() {
  const secret_name = "OpenAI-APIKEY";
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION || "us-west-1",
  });

  const response = await client.send(
    new GetSecretValueCommand({
      SecretId: secret_name,
      VersionStage: "AWSCURRENT",
    })
  );

  return response.SecretString;
}
