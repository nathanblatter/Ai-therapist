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

// RDS master credentials, kept in Secrets Manager. No longer used by the app at
// runtime (the app now uses the shared Postgres via DATABASE_URL); retained for
// the one-time data migration off RDS.
export async function getDbCredentials() {
  const secret_name = "rds!db-f7c70001-91ed-4b97-aa7a-8ecf922d7013";
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION || "us-west-1",
  });

  const response = await client.send(
    new GetSecretValueCommand({
      SecretId: secret_name,
      VersionStage: "AWSCURRENT",
    })
  );

  const secret = JSON.parse(response.SecretString);
  return {
    user: secret.username,
    password: secret.password,
    host: "ai-therapist.czmi8yuy2p4d.us-west-1.rds.amazonaws.com",
    port: 5432,
    database: "postgres",
  };
}
