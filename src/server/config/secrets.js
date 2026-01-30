import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import "dotenv/config";
export async function getOpenAIKey() {
const secret_name = "prod/ai-therapist/oaiAPIKey";

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
  const secret_name = "rds!db-9fa8f192-60a6-4918-ac0d-4c26a8a7bad3";
  
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
    host: 'ai-therapist-conversationlog-db.cduiqimmkaym.us-west-1.rds.amazonaws.com',
    port: 5432,
    database: 'postgres'
  }
}
export async function getAnthropicKey() {
const secret_name = "anthopicAPIkey";

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



