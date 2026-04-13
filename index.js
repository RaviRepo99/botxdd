const winston = require('winston');
const { initDB, pool } = require('./db');
const startBot = require('./bot');
require('dotenv').config();

// Configure logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/app.log' })
  ]
});

// Validate environment variables
function validateEnv() {
  const requiredVars = ['DATABASE_URL', 'BOT_TOKEN', 'ADMIN_ID'];
  const missingVars = requiredVars.filter(varName => !process.env[varName]);
  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }
}

// Retry logic for database initialization
async function initDatabaseWithRetry(maxRetries = 3, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`Attempting database initialization (Attempt ${attempt}/${maxRetries})`);
      await initDB();
      logger.info('Database initialized successfully');
      return;
    } catch (error) {
      logger.error(`Database initialization failed: ${error.message}`);
      if (attempt === maxRetries) {
        throw new Error(`Failed to initialize database after ${maxRetries} attempts: ${error.message}`);
      }
      logger.info(`Retrying in ${delayMs / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down application...');
  try {
    logger.info('Closing database connections...');
    await pool.end();
    logger.info('Database connections closed');
  } catch (error) {
    logger.error(`Error closing database connections: ${error.message}`);
  }
  logger.info('Application shutdown complete');
  process.exit(0);
}

// Handle process termination signals
process.on('SIGINT', () => {
  logger.info('Received SIGINT. Initiating graceful shutdown...');
  shutdown();
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM. Initiating graceful shutdown...');
  shutdown();
});

// Handle uncaught exceptions and unhandled promise rejections
process.on('uncaughtException', (error) => {
  logger.error(`Uncaught Exception: ${error.stack}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason.stack || reason}`);
  process.exit(1);
});

// Main application startup
async function startApp() {
  try {
    // Validate environment variables
    logger.info('Validating environment variables...');
    validateEnv();
    logger.info('Environment variables validated');

    // Initialize database with retry
    await initDatabaseWithRetry();

    // Start the bot
    logger.info('Starting Telegram bot...');
    startBot();
  } catch (error) {
    logger.error(`Application startup failed: ${error.message}`);
    process.exit(1);
  }
}

// Run the application
startApp();