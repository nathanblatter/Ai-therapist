// db.js
import pkg from 'pg';
import { getDbCredentials } from "./secrets.js";
const { Pool } = pkg;
const dbCredentials = await getDbCredentials();


const pool = new Pool({
  host: "ai-therapist.czmi8yuy2p4d.us-west-1.rds.amazonaws.com",
  port: 5432,
  user: dbCredentials.user, // or whatever your master username is
  password: dbCredentials.password,
  database: 'postgres', // or your chosen DB name
  ssl: {
    rejectUnauthorized: false, // ← 👈 disables cert verification
  },
  // Set timezone to Mountain Time (handles both MST and MDT automatically)
  options: '-c timezone=America/Denver',
});



export {pool};
