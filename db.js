// db.js
import pkg from 'pg';
import { getDbCredentials } from "./loadSecrets.js";
const { Pool } = pkg;
const dbCredentials = await getDbCredentials();


const pool = new Pool({
  host: 'ai-therapist-conversationlog-db.cduiqimmkaym.us-west-1.rds.amazonaws.com',
  port: 5432,
  user: dbCredentials.user, // or whatever your master username is
  password: dbCredentials.password,
  database: 'postgres', // or your chosen DB name
  ssl: {
    rejectUnauthorized: true, // ← 👈 disables cert verification
  },
});



export {pool};
