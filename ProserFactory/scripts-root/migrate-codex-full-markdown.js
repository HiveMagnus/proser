const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Function to convert structured codex entry to markdown
function convertToMarkdown(entry) {
  const { entry_type, entry_name, entry_description, attributes } = entry;
  
  let markdown = `# ${entry_type === 'character' ? 'Character' : entry_type === 'location' ? 'Location' : 'Item'} Name: ${entry_name}\n\n`;
  
  if (entry_type === 'character' && attributes) {
    if (attributes.age) markdown += `**Age:** ${attributes.age}\n`;
    if (attributes.occupation) markdown += `**Occupation:** ${attributes.occupation}\n\n`;
    
    if (entry_description) {
      markdown += `## Description\n${entry_description}\n\n`;
    }
    
    if (attributes.background) {
      markdown += `## Background\n${attributes.background}\n\n`;
    }
    
    if (attributes.appearance) {
      markdown += `## Appearance\n${attributes.appearance}\n\n`;
    }
    
    if (attributes.personality_traits && attributes.personality_traits.length > 0) {
      markdown += `## Personality Traits\n`;
      attributes.personality_traits.forEach(trait => {
        markdown += `- ${trait}\n`;
      });
      markdown += `\n`;
    }
    
    if (attributes.motivations && attributes.motivations.length > 0) {
      markdown += `## Motivations\n`;
      attributes.motivations.forEach(motivation => {
        markdown += `- ${motivation}\n`;
      });
      markdown += `\n`;
    }
    
    if (attributes.relationships && Object.keys(attributes.relationships).length > 0) {
      markdown += `## Relationships\n`;
      Object.entries(attributes.relationships).forEach(([name, desc]) => {
        markdown += `- **${name}:** ${desc}\n`;
      });
      markdown += `\n`;
    }
  } else if (entry_type === 'location' && attributes) {
    if (attributes.type) markdown += `**Type:** ${attributes.type}\n`;
    if (attributes.geography) markdown += `**Geography:** ${attributes.geography}\n`;
    if (attributes.climate) markdown += `**Climate:** ${attributes.climate}\n\n`;
    
    if (entry_description) {
      markdown += `## Description\n${entry_description}\n\n`;
    }
    
    if (attributes.history) {
      markdown += `## History\n${attributes.history}\n\n`;
    }
    
    if (attributes.notable_features && attributes.notable_features.length > 0) {
      markdown += `## Notable Features\n`;
      attributes.notable_features.forEach(feature => {
        markdown += `- ${feature}\n`;
      });
      markdown += `\n`;
    }
    
    if (attributes.inhabitants && attributes.inhabitants.length > 0) {
      markdown += `## Inhabitants\n`;
      attributes.inhabitants.forEach(inhabitant => {
        markdown += `- ${inhabitant}\n`;
      });
      markdown += `\n`;
    }
  } else if (entry_type === 'item' && attributes) {
    if (attributes.type) markdown += `**Type:** ${attributes.type}\n\n`;
    
    if (entry_description) {
      markdown += `## Description\n${entry_description}\n\n`;
    }
    
    if (attributes.history) {
      markdown += `## History\n${attributes.history}\n\n`;
    }
    
    if (attributes.significance) {
      markdown += `## Significance\n${attributes.significance}\n\n`;
    }
    
    if (attributes.current_location) {
      markdown += `## Current Location\n${attributes.current_location}\n\n`;
    }
    
    if (attributes.properties && attributes.properties.length > 0) {
      markdown += `## Properties\n`;
      attributes.properties.forEach(property => {
        markdown += `- ${property}\n`;
      });
      markdown += `\n`;
    }
  } else {
    // Fallback for entries without structured attributes
    if (entry_description) {
      markdown += `## Description\n${entry_description}\n\n`;
    }
  }
  
  return markdown.trim();
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

const migrateCodexToFullMarkdown = () => {
  console.log('Migrating codex entries to full markdown format...');

  try {
    // Get all codex entries
    const codexEntries = db.prepare(`
      SELECT id, entry_type, entry_name, entry_description, attributes 
      FROM codex_entries
    `).all();

    console.log(`Found ${codexEntries.length} codex entries to migrate`);

    const updateStatement = db.prepare(`
      UPDATE codex_entries 
      SET entry_description = ?, attributes = ?
      WHERE id = ?
    `);

    let migratedCount = 0;

    for (const entry of codexEntries) {
      try {
        // Parse JSON attributes if they exist
        let attributes = {};
        if (entry.attributes && typeof entry.attributes === 'string') {
          try {
            attributes = JSON.parse(entry.attributes);
          } catch (e) {
            console.log(`Warning: Could not parse attributes for entry ${entry.id}`);
          }
        } else if (entry.attributes && typeof entry.attributes === 'object') {
          attributes = entry.attributes;
        }

        // Convert to full markdown
        const fullMarkdown = convertToMarkdown({
          entry_type: entry.entry_type,
          entry_name: entry.entry_name,
          entry_description: entry.entry_description,
          attributes: attributes
        });

        // Update the entry with full markdown and empty attributes
        updateStatement.run(fullMarkdown, '{}', entry.id);
        migratedCount++;
        
        console.log(`Migrated entry ${entry.id} (${entry.entry_name}): ${fullMarkdown.substring(0, 100)}...`);
      } catch (error) {
        console.error(`Error migrating entry ${entry.id}:`, error);
      }
    }

    console.log(`Successfully migrated ${migratedCount} codex entries to full markdown format.`);
  } catch (error) {
    console.error('Error migrating codex entries:', error);
    throw error;
  }
};

try {
  console.log('Starting codex full markdown migration...');
  migrateCodexToFullMarkdown();
  console.log('Codex full markdown migration completed successfully!');
} catch (error) {
  console.error('Migration failed:', error);
  process.exit(1);
}

db.close();
