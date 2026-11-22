const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'proser.db');
const db = new Database(dbPath);

console.log('Adding wizard session tables...');

try {
  // Create wizard_sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS wizard_sessions (
      id TEXT PRIMARY KEY,
      book_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      current_phase INTEGER DEFAULT 1,
      current_step INTEGER DEFAULT 0,
      total_steps INTEGER NOT NULL,
      status TEXT DEFAULT 'running',
      settings TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (book_id) REFERENCES books (id),
      FOREIGN KEY (user_id) REFERENCES users (id)
    )
  `);

  // Create wizard_progress table for detailed step tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS wizard_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      phase INTEGER NOT NULL,
      step INTEGER NOT NULL,
      step_type TEXT NOT NULL,
      description TEXT,
      result TEXT,
      status TEXT DEFAULT 'pending',
      started_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES wizard_sessions (id)
    )
  `);

  console.log('✅ Wizard tables created successfully');
} catch (error) {
  console.error('❌ Error creating wizard tables:', error.message);
  process.exit(1);
}

db.close();
