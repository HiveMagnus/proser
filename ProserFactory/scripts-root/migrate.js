const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'proser.db');
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

const runMigrations = () => {
  console.log('Running database migrations...');

  // Check if the tagline column exists in the books table
  const bookTableInfo = db.prepare("PRAGMA table_info(books)").all();
  const hasTaglineColumn = bookTableInfo.some(column => column.name === 'tagline');
  const hasStoryOutlineColumn = bookTableInfo.some(column => column.name === 'story_outline');

  if (!hasTaglineColumn) {
    console.log('Adding tagline column to books table...');
    db.exec(`
      ALTER TABLE books ADD COLUMN tagline TEXT;
    `);
    console.log('Tagline column added successfully.');
  } else {
    console.log('Tagline column already exists.');
  }

  if (!hasStoryOutlineColumn) {
    console.log('Adding story_outline column to books table...');
    db.exec(`
      ALTER TABLE books ADD COLUMN story_outline TEXT;
    `);
    console.log('Story outline column added successfully.');
  } else {
    console.log('Story outline column already exists.');
  }

  console.log('Migration completed successfully!');
};

try {
  runMigrations();
} catch (error) {
  console.error('Migration failed:', error);
  process.exit(1);
} finally {
  db.close();
}
