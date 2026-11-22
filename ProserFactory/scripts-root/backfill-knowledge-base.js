/**
 * Backfill Knowledge Base Script
 * 
 * This script creates knowledge chunks and snapshots for existing:
 * - Acts, Chapters, Scenes (story structure)
 * - Notes (user notes)
 * - Codex entries (characters, locations, items)
 */

const path = require('path');

// Import Prisma Client from backend directory
const { PrismaClient } = require(path.join(__dirname, '../backend/node_modules/@prisma/client'));

const prisma = new PrismaClient({
  log: ['info', 'warn', 'error'],
});

// Helper function to extract text content from various sources
function extractTextContent(content) {
  if (!content) return '';
  
  // If content looks like HTML, do basic cleanup
  if (typeof content === 'string' && content.includes('<')) {
    return content
      .replace(/<[^>]*>/g, ' ')  // Remove HTML tags
      .replace(/\s+/g, ' ')       // Normalize whitespace
      .trim();
  }
  
  return String(content).trim();
}

// Generate short summary from content
function generateShortSummary(content, title = '') {
  if (!content) return null;
  
  const text = extractTextContent(content);
  if (!text) return null;
  
  // Simple summarization: use first 300 chars
  let summary = text.substring(0, 300);
  
  // Try to end at a sentence boundary
  const lastPeriod = summary.lastIndexOf('.');
  const lastExclamation = summary.lastIndexOf('!');
  const lastQuestion = summary.lastIndexOf('?');
  
  const lastSentenceEnd = Math.max(lastPeriod, lastExclamation, lastQuestion);
  if (lastSentenceEnd > 100) {
    summary = summary.substring(0, lastSentenceEnd + 1);
  }
  
  // If we have a title, prefer it for very short content
  if (title && text.length < 100) {
    return `${title}: ${text}`;
  }
  
  return summary.trim() || null;
}

// Generate tags from content and metadata
function generateTags(content, title = '', entityType = '', extraTags = []) {
  const tags = [...extraTags, entityType].filter(Boolean);
  
  // Add basic content-based tags
  const text = `${title} ${extractTextContent(content)}`.toLowerCase();
  
  // Common writing-related keywords
  const keywordMap = {
    'character': ['character', 'person', 'protagonist', 'antagonist'],
    'location': ['location', 'place', 'setting', 'scene'],
    'plot': ['plot', 'story', 'narrative', 'conflict'],
    'dialogue': ['dialogue', 'conversation', 'speech', 'talk'],
    'action': ['action', 'fight', 'battle', 'chase'],
    'emotion': ['emotion', 'feeling', 'love', 'fear', 'anger', 'joy'],
    'mystery': ['mystery', 'secret', 'hidden', 'unknown'],
    'fantasy': ['magic', 'fantasy', 'spell', 'wizard', 'dragon'],
    'scifi': ['sci-fi', 'science', 'future', 'space', 'technology'],
  };
  
  for (const [tag, keywords] of Object.entries(keywordMap)) {
    if (keywords.some(keyword => text.includes(keyword))) {
      tags.push(tag);
    }
  }
  
  return tags.length > 0 ? tags.slice(0, 8).join(',') : null;
}

// Helper function for upserting knowledge chunks
async function upsertKnowledgeChunk({ bookId, sourceType, sourceId, title, content, shortSummary, tags }) {
  // Try to find existing chunk
  const existing = await prisma.knowledgeChunk.findFirst({
    where: {
      bookId,
      sourceType,
      sourceId,
    }
  });
  
  const data = {
    title,
    content,
    shortSummary,
    tags,
    updatedAt: new Date(),
  };
  
  if (existing) {
    return await prisma.knowledgeChunk.update({
      where: { id: existing.id },
      data,
    });
  } else {
    return await prisma.knowledgeChunk.create({
      data: {
        bookId,
        sourceType,
        sourceId,
        ...data,
      },
    });
  }
}

async function backfillActsChaptersScenes() {
  console.log('🏗️  Backfilling Acts, Chapters, and Scenes...');
  
  const acts = await prisma.act.findMany({
    include: {
      book: true,
      chapters: {
        include: {
          scenes: true,
        }
      }
    }
  });
  
  let actCount = 0, chapterCount = 0, sceneCount = 0;
  
  for (const act of acts) {
    // Create knowledge chunk for Act
    if (act.title || act.summary) {
      await upsertKnowledgeChunk({
        bookId: act.bookId,
        sourceType: 'act',
        sourceId: act.id,
        title: act.title || `Act ${act.actNumber}`,
        content: act.summary || `Act ${act.actNumber}`,
        shortSummary: generateShortSummary(act.summary, act.title),
        tags: generateTags(act.summary, act.title, 'act', ['story-structure']),
      });
      actCount++;
    }
    
    // Process chapters
    for (const chapter of act.chapters) {
      if (chapter.title || chapter.summary) {
        await upsertKnowledgeChunk({
          bookId: act.bookId,
          sourceType: 'chapter',
          sourceId: chapter.id,
          title: chapter.title || `Chapter ${chapter.chapterNumber}`,
          content: chapter.summary || `Chapter ${chapter.chapterNumber}`,
          shortSummary: generateShortSummary(chapter.summary, chapter.title),
          tags: generateTags(chapter.summary, chapter.title, 'chapter', ['story-structure']),
        });
        chapterCount++;
      }
      
      // Process scenes
      for (const scene of chapter.scenes) {
        const sceneContent = [scene.outline, scene.summary, scene.prose]
          .filter(Boolean)
          .join('\n\n');
        
        if (sceneContent.trim()) {
          await upsertKnowledgeChunk({
            bookId: act.bookId,
            sourceType: 'scene',
            sourceId: scene.id,
            title: scene.title || `Scene ${scene.sceneNumber}`,
            content: sceneContent,
            shortSummary: generateShortSummary(sceneContent, scene.title),
            tags: generateTags(sceneContent, scene.title, 'scene', ['story-structure', 'prose']),
          });
          sceneCount++;
        }
      }
    }
  }
  
  console.log(`✅ Processed ${actCount} acts, ${chapterCount} chapters, ${sceneCount} scenes`);
}

async function backfillNotes() {
  console.log('📝 Backfilling Notes...');
  
  const notes = await prisma.note.findMany({
    include: { book: true }
  });
  
  let noteCount = 0;
  
  for (const note of notes) {
    if (note.content?.trim()) {
      await upsertKnowledgeChunk({
        bookId: note.bookId,
        sourceType: 'note',
        sourceId: note.id,
        title: note.title,
        content: note.content,
        shortSummary: generateShortSummary(note.content, note.title),
        tags: generateTags(note.content, note.title, 'note', ['user-notes']),
      });
      noteCount++;
    }
  }
  
  console.log(`✅ Processed ${noteCount} notes`);
}

async function backfillCodexEntries() {
  console.log('📚 Backfilling Codex Entries...');
  
  const codexEntries = await prisma.codexEntry.findMany({
    include: { book: true }
  });
  
  let codexCount = 0;
  
  for (const entry of codexEntries) {
    const content = [entry.entryDescription, entry.attributes]
      .filter(Boolean)
      .join('\n\n');
    
    if (content.trim()) {
      await upsertKnowledgeChunk({
        bookId: entry.bookId,
        sourceType: 'codex',
        sourceId: entry.id,
        title: entry.entryName,
        content: content,
        shortSummary: generateShortSummary(content, entry.entryName),
        tags: generateTags(content, entry.entryName, 'codex', [entry.entryType, 'worldbuilding']),
      });
      codexCount++;
    }
  }
  
  console.log(`✅ Processed ${codexCount} codex entries`);
}

async function createKnowledgeSnapshots() {
  console.log('📸 Creating Knowledge Snapshots...');
  
  const books = await prisma.book.findMany({
    include: {
      acts: {
        include: {
          chapters: {
            include: {
              scenes: true,
            }
          }
        }
      }
    }
  });
  
  let snapshotCount = 0;
  
  for (const book of books) {
    // Create book-level snapshot
    const bookChunks = await prisma.knowledgeChunk.findMany({
      where: { bookId: book.id },
      select: { 
        shortSummary: true,
        tags: true,
        sourceType: true,
      }
    });
    
    if (bookChunks.length > 0) {
      const summary = `Book "${book.title || 'Untitled'}" contains ${bookChunks.length} knowledge chunks including ${book.acts.length} acts, ${book.acts.reduce((sum, act) => sum + act.chapters.length, 0)} chapters, and ${book.acts.reduce((sum, act) => sum + act.chapters.reduce((chapterSum, chapter) => chapterSum + chapter.scenes.length, 0), 0)} scenes.`;
      
      // Simple facts extraction
      const sourceTypeCounts = bookChunks.reduce((acc, chunk) => {
        acc[chunk.sourceType] = (acc[chunk.sourceType] || 0) + 1;
        return acc;
      }, {});
      
      const allTags = bookChunks
        .filter(chunk => chunk.tags)
        .flatMap(chunk => chunk.tags.split(','))
        .map(tag => tag.trim())
        .filter(tag => tag.length > 0);
      
      const tagCounts = allTags.reduce((acc, tag) => {
        acc[tag] = (acc[tag] || 0) + 1;
        return acc;
      }, {});
      
      const facts = {
        contentCounts: sourceTypeCounts,
        topTags: Object.entries(tagCounts)
          .sort(([,a], [,b]) => b - a)
          .slice(0, 10)
          .reduce((acc, [tag, count]) => ({ ...acc, [tag]: count }), {}),
        lastUpdated: new Date().toISOString(),
      };
      
      // Check for existing book snapshot
      const existingBookSnapshot = await prisma.knowledgeSnapshot.findFirst({
        where: {
          bookId: book.id,
          scope: 'book',
          refId: null,
        }
      });
      
      if (existingBookSnapshot) {
        await prisma.knowledgeSnapshot.update({
          where: { id: existingBookSnapshot.id },
          data: {
            summary: summary,
            factsJson: JSON.stringify(facts),
            updatedAt: new Date(),
          }
        });
      } else {
        await prisma.knowledgeSnapshot.create({
          data: {
            bookId: book.id,
            scope: 'book',
            refId: null,
            summary: summary,
            factsJson: JSON.stringify(facts),
          }
        });
      }
      snapshotCount++;
    }
    
    // Create act-level snapshots
    for (const act of book.acts) {
      const actChunks = await prisma.knowledgeChunk.findMany({
        where: {
          bookId: book.id,
          OR: [
            { sourceType: 'act', sourceId: act.id },
            { 
              sourceType: 'chapter', 
              sourceId: { in: act.chapters.map(ch => ch.id) } 
            },
            { 
              sourceType: 'scene', 
              sourceId: { 
                in: act.chapters.flatMap(ch => ch.scenes.map(sc => sc.id)) 
              } 
            }
          ]
        }
      });
      
      if (actChunks.length > 0) {
        const summary = `Act ${act.actNumber} contains ${actChunks.length} knowledge chunks across ${act.chapters.length} chapters.`;
        
        // Check for existing act snapshot
        const existingActSnapshot = await prisma.knowledgeSnapshot.findFirst({
          where: {
            bookId: book.id,
            scope: 'act',
            refId: act.id,
          }
        });
        
        if (existingActSnapshot) {
          await prisma.knowledgeSnapshot.update({
            where: { id: existingActSnapshot.id },
            data: {
              summary: summary,
              updatedAt: new Date(),
            }
          });
        } else {
          await prisma.knowledgeSnapshot.create({
            data: {
              bookId: book.id,
              scope: 'act',
              refId: act.id,
              summary: summary,
            }
          });
        }
        snapshotCount++;
      }
    }
  }
  
  console.log(`✅ Created ${snapshotCount} knowledge snapshots`);
}

async function main() {
  console.log('🚀 Starting Knowledge Base Backfill...\n');
  
  try {
    await prisma.$connect();
    console.log('✅ Connected to database\n');
    
    // Backfill knowledge chunks
    await backfillActsChaptersScenes();
    await backfillNotes();
    await backfillCodexEntries();
    
    // Create snapshots
    await createKnowledgeSnapshots();
    
    // Summary stats
    const totalChunks = await prisma.knowledgeChunk.count();
    const totalSnapshots = await prisma.knowledgeSnapshot.count();
    const chunksByType = await prisma.knowledgeChunk.groupBy({
      by: ['sourceType'],
      _count: { sourceType: true },
    });
    
    console.log('\n📊 Final Statistics:');
    console.log(`   Total Knowledge Chunks: ${totalChunks}`);
    console.log(`   Total Knowledge Snapshots: ${totalSnapshots}`);
    console.log('   Chunks by type:');
    chunksByType.forEach(({ sourceType, _count }) => {
      console.log(`     ${sourceType}: ${_count.sourceType}`);
    });
    
    console.log('\n🎉 Backfill completed successfully!');
    
  } catch (error) {
    console.error('❌ Backfill failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Handle cleanup on exit
process.on('SIGINT', async () => {
  console.log('\n⚠️  Received interrupt signal, cleaning up...');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n⚠️  Received termination signal, cleaning up...');
  await prisma.$disconnect();
  process.exit(0);
});

if (require.main === module) {
  main();
}

module.exports = { main };
