# PayMe Telegram Bot

The PayMe Telegram Bot is a Node.js-based application that allows users to manage financial transactions via Telegram. Users can deposit and withdraw funds, set bank details, and view their profile and transaction history. Admins can approve or reject transactions, manage deposit account images, and view system statistics. The bot uses PostgreSQL for data storage and includes robust error handling, logging, and graceful shutdown.

## Features

### User Commands
- **/start**: Registers the user and displays a welcome message.
- **/help**: Lists available commands based on user role (user or admin).
- **/balance**: Displays the user's current balance.
- **/deposit**: Provides instructions to send a payment receipt photo for deposit (requires bank details).
- **/withdraw {amount}**: Submits a withdrawal request (requires bank details).
- **/transactions**: Lists the user's recent transactions (up to 10), including bank details and rejection reasons if applicable.
- **/bank {Bank Name}**: Sets the user's bank name (1–100 characters).
- **/account {account number}**: Sets the user's account number (8–20 digits).
- **/profile**: Displays user details (ID, username, balance, bank name, account number).

### Admin Commands
- **/account {imageURL}**: Sets the deposit account image URL (must end with .jpg, .png, or .webp).
- **/approve {amount} = {id}**: Approves a transaction by ID, updating user balance.
- **/reject {id} = {reason}**: Rejects a transaction by ID with a specified reason.
- **/pending**: Lists all pending transactions with user and bank details.
- **/dashboard**: Shows a summary of users (total, with bank details, total balance) and transactions (approved deposits, withdrawals, pending).

### Additional Features
- **Bank Details Requirement**: Users must set bank name and account number before making transactions.
- **Admin Notifications**: Deposit and withdrawal requests include user bank details for admin review.
- **Conversation Forwarding**: Non-command user messages (text, photos, documents) are forwarded to the admin, with admin replies relayed back (excluding commands).
- **Error Handling**: Robust error handling for database operations, bot commands, and startup.
- **Logging**: Structured logging with timestamps to console and `logs/app.log` using Winston.
- **Graceful Shutdown**: Handles `SIGINT` and `SIGTERM` to close database connections cleanly.

## Prerequisites
- **Node.js**: Version 14 or higher.
- **PostgreSQL**: A running PostgreSQL database (local or hosted).
- **Telegram Bot Token**: Obtain from [BotFather](https://t.me/BotFather).
- **Environment Variables**:
  - `DATABASE_URL`: PostgreSQL connection string (e.g., `postgres://user:password@localhost:5432/dbname`).
  - `BOT_TOKEN`: Telegram bot token from BotFather.
  - `ADMIN_ID`: Telegram ID of the admin user.

## Installation

1. **Clone the Repository**:
   ```bash
   git clone <repository-url>
   cd payme-telegram-bot
   ```

2. **Install Dependencies**:
   ```bash
   npm install node-telegram-bot-api pg dotenv winston
   ```

3. **Set Up Environment Variables**:
   Create a `.env` file in the project root:
   ```env
   DATABASE_URL=your_postgres_connection_string
   BOT_TOKEN=your_telegram_bot_token
   ADMIN_ID=your_admin_telegram_id
   ```

4. **Set Up Logs Directory**:
   ```bash
   mkdir logs
   ```

5. **Initialize the Database**:
   Ensure your PostgreSQL database is running. The bot automatically creates the following tables on startup:
   - `users`: Stores user ID, username, balance, bank name, and account number.
   - `transactions`: Stores transaction details (ID, user ID, type, amount, status, reason, timestamp).
   - `config`: Stores configuration (e.g., deposit image URL).

   If the database schema already exists, ensure it includes the following columns:
   ```sql
   ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_name TEXT;
   ALTER TABLE users ADD COLUMN IF NOT EXISTS account_number TEXT;
   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reason TEXT;
   ```

6. **Run the Bot**:
   ```bash
   node index.js
   ```

## Usage

### For Users
1. Start the bot with `/start` to register.
2. Set bank details using `/bank {Bank Name}` and `/account {account number}`.
3. Check your profile with `/profile`.
4. Use `/deposit` to receive a QR code or image for payment, then reply with a receipt photo.
5. Request a withdrawal with `/withdraw {amount}`.
6. View recent transactions with `/transactions`.
7. Use `/balance` to check your balance.
8. Send messages, photos, or documents to communicate with the admin (non-command messages are forwarded).

### For Admins
1. Use `/help` to see all commands (user and admin).
2. Set the deposit image URL with `/account {imageURL}`.
3. Review pending transactions with `/pending`.
4. Approve transactions with `/approve {amount} = {id}` or by replying with a receipt photo for withdrawals.
5. Reject transactions with `/reject {id} = {reason}`.
6. View system statistics with `/dashboard`.
7. Reply to forwarded user messages to communicate with users (commands are not forwarded).

## Project Structure
- `index.js`: Entry point; validates environment, initializes the database, and starts the bot.
- `db.js`: Configures PostgreSQL connection and initializes tables.
- `bot.js`: Contains the Telegram bot logic, command handlers, and message processing.
- `logs/app.log`: Stores application logs (created automatically).
- `.env`: Environment variables (not tracked in version control).

## Database Schema
- **users**:
  - `id`: BIGINT (Primary Key, Telegram user ID)
  - `username`: TEXT (Telegram username or 'unknown')
  - `balance`: NUMERIC (Default 0)
  - `bank_name`: TEXT (User's bank name)
  - `account_number`: TEXT (User's account number)
- **transactions**:
  - `id`: SERIAL (Primary Key)
  - `user_id`: BIGINT (Foreign Key to users.id)
  - `type`: TEXT (deposit or withdraw)
  - `amount`: NUMERIC
  - `status`: TEXT (pending, approved, rejected)
  - `reason`: TEXT (Rejection reason, if applicable)
  - `created_at`: TIMESTAMP (Default CURRENT_TIMESTAMP)
- **config**:
  - `key`: TEXT (Primary Key, e.g., 'deposit_image_url')
  - `value`: TEXT (Configuration value)

## Logging
- Logs are written to `logs/app.log` and the console.
- Includes timestamps, log levels (INFO, ERROR), and details for startup, shutdown, errors, and database retries.
- Example log: `2025-06-24 21:14:45 [INFO]: Database initialized successfully`

## Development Notes
- **Error Handling**: The bot includes try-catch blocks for all database operations and command executions.
- **Retries**: Database initialization retries up to 3 times with a 5-second delay.
- **Shutdown**: Handles `SIGINT` and `SIGTERM` to close database connections cleanly.
- **Security**: Validate environment variables and user inputs (e.g., account number: 8–20 digits).
- **Extensibility**: Add a health check endpoint or log rotation by extending `index.js`.

## Troubleshooting
- **Bot Not Starting**: Check `logs/app.log` for errors. Ensure `.env` variables are set and PostgreSQL is running.
- **Database Errors**: Verify `DATABASE_URL` and run the schema migration if needed.
- **Command Issues**: Ensure users set bank details before transactions. Admins must use correct command syntax (e.g., `/approve 100 = 123`).

## Contributing
Contributions are welcome! Please:
1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/your-feature`).
3. Commit changes (`git commit -m "Add your feature"`).
4. Push to the branch (`git push origin feature/your-feature`).
5. Open a pull request.

## Author
- **Samir Thakuri** - [GitHub](https://github.com/notsopreety)
