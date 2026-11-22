const { getArchetypeDescription } = require('./dist/config/storyArchetypes.js');

// Test archetype lookup
console.log('Testing archetype lookup...');

const testCases = [
  'overcoming-the-monster',
  'rags-to-riches', 
  'love-story',
  'fated-mates',
  'invalid-key',
  null,
  undefined
];

for (const testCase of testCases) {
  const description = getArchetypeDescription(testCase);
  console.log(`"${testCase}" -> "${description}"`);
}
