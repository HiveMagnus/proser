#!/usr/bin/env node

// Test script to call prose generation directly
const fetch = require('node-fetch');

const BACKEND_URL = 'http://localhost:3001';

async function testProseGeneration() {
  const bookId = 847; // From the logs - "The Greatest Test 3"
  
  const payload = {
    bookId,
    prompt: 'Generate a test scene',
    useCodexRAG: false
  };
  
  console.log('Testing prose generation...');
  console.log('Payload:', JSON.stringify(payload, null, 2));
  
  try {
    const response = await fetch(`${BACKEND_URL}/api/generate/prose`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': '1' // Fake user ID for testing
      },
      body: JSON.stringify(payload)
    });
    
    const result = await response.json();
    console.log('Response status:', response.status);
    console.log('Response body:', JSON.stringify(result, null, 2));
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testProseGeneration();
