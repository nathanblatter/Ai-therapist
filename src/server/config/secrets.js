import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import "dotenv/config";
export async function getOpenAIKey() {
const secret_name = "OpenAI-APIKEY";

const client = new SecretsManagerClient({


    region: process.env.AWS_REGION || 'us-west-1'
    
});

let response;

try {
  response = await client.send(
    new GetSecretValueCommand({
      SecretId: secret_name,
      VersionStage: "AWSCURRENT", // VersionStage defaults to AWSCURRENT if unspecified
    })
  );
} catch (error) {
  // For a list of exceptions thrown, see
  // https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html
  throw error;
}

const secret = response.SecretString;

// Your code goes here
return secret;
}
export async function getDbCredentials() {
  const secret_name = "rds!db-f7c70001-91ed-4b97-aa7a-8ecf922d7013";
  
  const client = new SecretsManagerClient({
  
  
      region: process.env.AWS_REGION 
      
  });
  
  let response;
  
  try {
    response = await client.send(
      new GetSecretValueCommand({
        SecretId: secret_name,
        VersionStage: "AWSCURRENT", // VersionStage defaults to AWSCURRENT if unspecified
      })
    );
  } catch (error) {
    // For a list of exceptions thrown, see
    // https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html
    throw error;
  }
  
  const raw = response.SecretString;
  const secret = JSON.parse(raw);
  
  
  // Your code goes here
  return {
    user: secret.username, // or whatever your master username is
    password: secret.password,
    host: "ai-therapist.czmi8yuy2p4d.us-west-1.rds.amazonaws.com",
    port: 5432,
    database: 'postgres'
  }
}