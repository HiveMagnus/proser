import { fetchPrompt } from './src/lib/promptsClient.js';

async function test() {
  try {
    const prompt = await fetchPrompt('prose');
    console.log('Success: Fetched prompt');
    console.log('Template exists:', !!prompt.template);
    console.log('Template length:', prompt.template.length);
    console.log('First 100 chars:', prompt.template.substring(0, 100));
  } catch (err) {
    console.error('Error:', err.message);
  }
}

test();
