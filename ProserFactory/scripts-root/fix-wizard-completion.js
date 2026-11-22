const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'proser.db');
const db = new Database(dbPath);

console.log('Checking and fixing wizard completion...');

try {
  // Clean up stuck sessions
  const stuckSessions = db.prepare("SELECT id FROM wizard_sessions WHERE status = 'running' AND updated_at < datetime('now', '-10 minutes')").all();
  
  if (stuckSessions.length > 0) {
    console.log(`Found ${stuckSessions.length} stuck session(s), cleaning up...`);
    stuckSessions.forEach(session => {
      db.prepare("UPDATE wizard_sessions SET status = 'cancelled' WHERE id = ?").run(session.id);
      console.log(`✅ Cancelled stuck session: ${session.id}`);
    });
  }

  // Check if we have completed wizard progress but no book structure
  const completedSessions = db.prepare("SELECT id, book_id FROM wizard_sessions WHERE status = 'completed'").all();
  
  for (const session of completedSessions) {
    console.log(`\nChecking completed session: ${session.id}`);
    
    // Check if we have acts for this book
    const existingActs = db.prepare("SELECT COUNT(*) as count FROM acts WHERE book_id = ?").get(session.book_id);
    
    if (existingActs.count === 0) {
      console.log(`No acts found for book ${session.book_id}, creating structure...`);
      
      // Get the wizard progress results
      const progressResults = db.prepare(`
        SELECT phase, step, step_type, result, description 
        FROM wizard_progress 
        WHERE session_id = ? AND status = 'completed' AND result IS NOT NULL
        ORDER BY phase, step
      `).all(session.id);
      
      if (progressResults.length > 0) {
        // Create Act 1
        const actResult = db.prepare(`
          INSERT INTO acts (book_id, act_number, title, summary) 
          VALUES (?, ?, ?, ?)
        `).run(
          session.book_id,
          1,
          'Act I: The Beginning',
          'Generated act from wizard'
        );
        
        const actId = actResult.lastInsertRowid;
        console.log(`✅ Created Act ${actId}`);

        // Group results by type
        const sceneOutlines = progressResults.filter(r => r.step_type === 'scene_outline');
        const proseResults = progressResults.filter(r => r.step_type === 'prose_generation');
        
        // Create chapters and scenes
        const maxItems = Math.max(sceneOutlines.length, proseResults.length);
        for (let i = 0; i < maxItems; i++) {
          // Create chapter
          const chapterResult = db.prepare(`
            INSERT INTO chapters (act_id, chapter_number, title, summary) 
            VALUES (?, ?, ?, ?)
          `).run(
            actId,
            i + 1,
            `Chapter ${i + 1}`,
            sceneOutlines[i]?.result?.substring(0, 500) || `Generated chapter ${i + 1}`
          );
          
          const chapterId = chapterResult.lastInsertRowid;

          // Create scene with prose content
          db.prepare(`
            INSERT INTO scenes (chapter_id, scene_number, title, summary, prose) 
            VALUES (?, ?, ?, ?, ?)
          `).run(
            chapterId,
            1,
            `Scene ${i + 1}`,
            sceneOutlines[i]?.result?.substring(0, 500) || `Generated scene ${i + 1}`,
            proseResults[i]?.result || ''
          );
        }
        
        console.log(`✅ Created ${maxItems} chapters with scenes`);
      }
    } else {
      console.log(`Book ${session.book_id} already has ${existingActs.count} acts`);
    }
  }

  // Final summary
  console.log('\n=== FINAL STATUS ===');
  const acts = db.prepare('SELECT COUNT(*) as count FROM acts').get();
  const chapters = db.prepare('SELECT COUNT(*) as count FROM chapters').get();
  const scenes = db.prepare('SELECT COUNT(*) as count FROM scenes').get();
  
  console.log(`📚 Book structure: ${acts.count} acts, ${chapters.count} chapters, ${scenes.count} scenes`);
  
  const activeSessions = db.prepare("SELECT COUNT(*) as count FROM wizard_sessions WHERE status = 'running'").get();
  console.log(`🔄 Active wizard sessions: ${activeSessions.count}`);
  
} catch (error) {
  console.error('❌ Error:', error.message);
  process.exit(1);
} finally {
  db.close();
}
