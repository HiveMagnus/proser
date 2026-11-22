const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'proser.db');
const db = new Database(dbPath);

console.log('Checking for template-style content...');

try {
  // Find scenes with template-style content
  const templateScenes = db.prepare(`
    SELECT s.id, s.title, s.summary, c.title as chapter_title, a.title as act_title
    FROM scenes s
    JOIN chapters c ON s.chapter_id = c.id
    JOIN acts a ON c.act_id = a.id
    WHERE s.summary LIKE '%template%' OR s.summary LIKE '%Here''s a template%' OR s.summary LIKE '%Adjust according%'
    ORDER BY s.id
  `).all();

  if (templateScenes.length > 0) {
    console.log(`Found ${templateScenes.length} scenes with template content:`);
    
    templateScenes.forEach(scene => {
      console.log(`\n- Scene ${scene.id}: ${scene.title}`);
      console.log(`  In: ${scene.act_title} > ${scene.chapter_title}`);
      console.log(`  Summary preview: ${scene.summary.substring(0, 100)}...`);
      
      // Update with better placeholder content
      const newSummary = `Scene ${scene.id}: A pivotal moment in the story where key events unfold. Characters face challenges and make decisions that drive the narrative forward. This scene advances the plot and develops character relationships.`;
      
      db.prepare('UPDATE scenes SET summary = ? WHERE id = ?').run(newSummary, scene.id);
      console.log(`  ✅ Updated with improved content`);
    });
    
    console.log(`\n✅ Fixed ${templateScenes.length} scenes with template content`);
  } else {
    console.log('No template-style content found in scenes.');
  }

  // Check for template content in chapters
  const templateChapters = db.prepare(`
    SELECT c.id, c.title, c.summary, a.title as act_title
    FROM chapters c
    JOIN acts a ON c.act_id = a.id
    WHERE c.summary LIKE '%template%' OR c.summary LIKE '%Here''s a template%'
    ORDER BY c.id
  `).all();

  if (templateChapters.length > 0) {
    console.log(`\nFound ${templateChapters.length} chapters with template content:`);
    
    templateChapters.forEach(chapter => {
      console.log(`\n- Chapter ${chapter.id}: ${chapter.title}`);
      console.log(`  In: ${chapter.act_title}`);
      
      // Update with better content
      const newSummary = `${chapter.title}: A chapter that develops the story through character interactions, plot advancement, and world-building. Key events unfold that move the narrative toward its climax.`;
      
      db.prepare('UPDATE chapters SET summary = ? WHERE id = ?').run(newSummary, chapter.id);
      console.log(`  ✅ Updated with improved content`);
    });
  }

  console.log('\n=== CLEANUP COMPLETE ===');
  
} catch (error) {
  console.error('❌ Error:', error.message);
  process.exit(1);
} finally {
  db.close();
}
