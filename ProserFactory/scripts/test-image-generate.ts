import ky from 'ky';

async function main() {
  const base = process.env.API_BASE || 'http://localhost:3001/api';
  const prompt = process.env.PROMPT || 'A futuristic city at sunset with flying cars.';
  const body = {
    model: 'dall-e-3',
    prompt,
    n: 1,
    size: '1024x1024',
    quality: 'standard',
    response_format: 'url'
  } as const;
  const res = await ky.post(`${base}/images/generate`, {
    json: body,
    headers: {
      'x-user-id': process.env.X_USER_ID || '1',
      'x-github-id': process.env.X_GITHUB_ID || 'local-123'
    },
    timeout: 120_000
  }).json<{ success: boolean; data?: { data?: Array<{ url?: string; b64_json?: string }> } }>();

  const url = res?.data?.data?.[0]?.url;
  if (url) {
    console.log('Image URL:', url);
  } else {
    console.log('No URL in response:', JSON.stringify(res, null, 2));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
