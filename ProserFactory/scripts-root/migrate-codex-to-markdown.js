const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Simple HTML to Markdown converter for codex entries
function htmlToMarkdown(html) {
  if (!html || typeof html !== 'string') return '';
  
  return html
    // Convert headers
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
    .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n')
    .replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n')
    .replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n')
    
    // Convert emphasis
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
    
    // Convert lists
    .replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, '$1\n')
    .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, '$1\n')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    
    // Convert paragraphs and line breaks
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    
    // Remove any remaining HTML tags
    .replace(/<[^>]*>/g, '')
    
    // Clean up extra whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Ensure data directory exists
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'proser.db');
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

const migrateCodexToMarkdown = () => {
  console.log('Migrating codex entries from HTML to Markdown...');

  try {
    // Get all codex entries
    const codexEntries = db.prepare(`
      SELECT id, entry_description 
      FROM codex_entries 
      WHERE entry_description IS NOT NULL 
      AND entry_description != ''
    `).all();

    console.log(`Found ${codexEntries.length} codex entries to migrate`);

    const updateStatement = db.prepare(`
      UPDATE codex_entries 
      SET entry_description = ? 
      WHERE id = ?
    `);

    let migratedCount = 0;

    for (const entry of codexEntries) {
      // Check if the description looks like HTML (contains HTML tags)
      if (entry.entry_description.includes('<') && entry.entry_description.includes('>')) {
        const markdownDescription = htmlToMarkdown(entry.entry_description);
        updateStatement.run(markdownDescription, entry.id);
        migratedCount++;
        console.log(`Migrated entry ${entry.id}: ${entry.entry_description.substring(0, 50)}... -> ${markdownDescription.substring(0, 50)}...`);
      }
    }

    console.log(`Successfully migrated ${migratedCount} codex entries to Markdown format.`);
  } catch (error) {
    console.error('Error migrating codex entries:', error);
    throw error;
  }
};

try {
  console.log('Starting codex migration...');
  migrateCodexToMarkdown();
  console.log('Codex migration completed successfully!');
} catch (error) {
  console.error('Migration failed:', error);
  process.exit(1);
}

db.close();
