// db.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function initDB() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT PRIMARY KEY,
        username TEXT,
        balance NUMERIC DEFAULT 0,
        bank_name TEXT,
        account_number TEXT
      );
  
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id BIGINT,
        type TEXT CHECK (type IN ('deposit', 'withdraw')),
        amount NUMERIC,
        status TEXT CHECK (status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
        reason TEXT,
        platform TEXT,
        screenshot_file_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
  
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // Safe migration for existing deployments where transactions table already exists.
    await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS platform TEXT;`);
    await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS screenshot_file_id TEXT;`);
    await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS user_location TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS location TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP;`);
  
    // Default image placeholder
    await pool.query(`
      INSERT INTO config (key, value)
      VALUES ('deposit_image_url', 'https://i.ibb.co/qYRGzQbS/GIBL-qr-code-1750773746215.jpg')
      ON CONFLICT (key) DO NOTHING;
    `);
}

module.exports = {
  pool,
  initDB,
};
