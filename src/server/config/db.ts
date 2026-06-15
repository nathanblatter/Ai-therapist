// db.js
import pkg from 'pg';
import "dotenv/config";
const { Pool } = pkg;

// Connection comes from DATABASE_URL (e.g. the shared Postgres instance in
// docker-services, reached via host.docker.internal from inside the container).
// SSL is only enabled when DATABASE_SSL=true (used for managed Postgres like RDS);
// the self-hosted Postgres does not use TLS.
const useSsl = process.env.DATABASE_SSL === 'true';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  // Set timezone to Mountain Time (handles both MST and MDT automatically)
  options: '-c timezone=America/Denver',
});

export { pool };
