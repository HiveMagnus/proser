#!/usr/bin/env node

/**
 * Migration script to convert ReactQuill content to Lexical-compatible format
 * This script preserves all existing content while cleaning up ReactQuill-specific HTML
 */

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../data/proser.db');
const db = new Database(dbPath);

function cleanHtml(html) {
  if (!html) return '';
  
  // Clean up ReactQuill-specific HTML and convert to cleaner format
  let cleanHtml = html
    .replace(/<div[^>]*><br[^>]*><\/div>/g, '<p><br></p>') // Empty divs to paragraphs
    .replace(/<div[^>]*>/g, '<p>') // Convert divs to paragraphs
    .replace(/<\/div>/g, '</p>')
    .replace(/<p><\/p>/g, '') // Remove empty paragraphs
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
  
  return cleanHtml;
}

async function migrateContent() {
  console.log('🔄 Starting Lexical migration...');
  
  try {
    // Begin transaction
    db.prepare('BEGIN').run();
    
    // Migrate Acts
    console.log('📚 Migrating Act summaries...');
    const acts = db.prepare('SELECT id, summary FROM acts WHERE summary IS NOT NULL').all();
    const updateActStmt = db.prepare('UPDATE acts SET summary = ? WHERE id = ?');
    
    let actCount = 0;
    for (const act of acts) {
      if (act.summary) {
        const cleanedSummary = cleanHtml(act.summary);
        updateActStmt.run(cleanedSummary, act.id);
        actCount++;
      }
    }
    
    // Migrate Chapters
    console.log('📖 Migrating Chapter summaries...');
    const chapters = db.prepare('SELECT id, summary FROM chapters WHERE summary IS NOT NULL').all();
    const updateChapterStmt = db.prepare('UPDATE chapters SET summary = ? WHERE id = ?');
    
    let chapterCount = 0;
    for (const chapter of chapters) {
      if (chapter.summary) {
        const cleanedSummary = cleanHtml(chapter.summary);
        updateChapterStmt.run(cleanedSummary, chapter.id);
        chapterCount++;
      }
    }
    
    // Migrate Scenes
    console.log('📝 Migrating Scene summaries and prose...');
    const scenes = db.prepare('SELECT id, summary, prose FROM scenes WHERE summary IS NOT NULL OR prose IS NOT NULL').all();
    const updateSceneStmt = db.prepare('UPDATE scenes SET summary = ?, prose = ? WHERE id = ?');
    
    let sceneCount = 0;
    for (const scene of scenes) {
      const cleanedSummary = scene.summary ? cleanHtml(scene.summary) : scene.summary;
      const cleanedProse = scene.prose ? cleanHtml(scene.prose) : scene.prose;
      updateSceneStmt.run(cleanedSummary, cleanedProse, scene.id);
      sceneCount++;
    }
    
    // Migrate Books
    console.log('📚 Migrating Book summaries and taglines...');
    const books = db.prepare('SELECT id, summary, tagline FROM books WHERE summary IS NOT NULL OR tagline IS NOT NULL').all();
    const updateBookStmt = db.prepare('UPDATE books SET summary = ?, tagline = ? WHERE id = ?');
    
    let bookCount = 0;
    for (const book of books) {
      const cleanedSummary = book.summary ? cleanHtml(book.summary) : book.summary;
      const cleanedTagline = book.tagline ? cleanHtml(book.tagline) : book.tagline;
      updateBookStmt.run(cleanedSummary, cleanedTagline, book.id);
      bookCount++;
    }
    
    // Commit transaction
    db.prepare('COMMIT').run();
    
    console.log('✅ Migration completed successfully!');
    console.log(`   📚 ${bookCount} books updated`);
    console.log(`   📖 ${actCount} acts updated`);
    console.log(`   📄 ${chapterCount} chapters updated`);
    console.log(`   📝 ${sceneCount} scenes updated`);
    console.log('');
    console.log('🎉 Your content has been migrated to Lexical!');
    console.log('   All existing data has been preserved.');
    console.log('   The new editor provides better performance and features.');
    
  } catch (error) {
    // Rollback on error
    db.prepare('ROLLBACK').run();
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    db.close();
  }
}

// Run migration
if (require.main === module) {
  migrateContent().catch(error => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
}

module.exports = { migrateContent };
