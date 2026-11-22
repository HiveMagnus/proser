/** Install and exercise the renderer for the exact installed Playwright release. */
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const [name, override] of [['.env', false], ['.env.local', true]]) {
  const result = dotenv.config({ path: fileURLToPath(new URL(`../${name}`, import.meta.url)), override, quiet: true });
  if (result.error && !(name === '.env.local' && result.error.code === 'ENOENT')) throw result.error;
}
// Systemd reads the protected environment as root before starting its user.
// Apply the same boundary here, without exposing credentials in child arguments.
if (process.argv[2] === '--service-user') {
  const user = process.argv[3];
  if (process.getuid() !== 0 || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(user ?? '')) throw new Error('A root operator and explicit service user are required.');
  const entry = spawnSync('getent', ['passwd', user], { encoding: 'utf8' });
  if (entry.status !== 0) throw new Error('Publication service user is unavailable.');
  const fields = entry.stdout.trim().split(':');
  const uid = Number(fields[2]), gid = Number(fields[3]);
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1 || !fields[5]?.startsWith('/')) throw new Error('Invalid publication service identity.');
  process.env.HOME = fields[5];
  process.env.USER = process.env.LOGNAME = user;
  process.initgroups(user, gid);
  process.setgid(gid);
  process.setuid(uid);
} else if (process.argv.length > 2) throw new Error('Usage: install-publication-browser.mjs [--service-user USER]');
const { chromium } = await import('playwright');
const install = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/playwright/cli.js', import.meta.url)), 'install', 'chromium'], { cwd: root, env: process.env, stdio: 'inherit' });
if (install.error) throw install.error;
if (install.status !== 0) throw new Error('Installing the pinned publication renderer failed.');
const browser = await chromium.launch({ headless: true, timeout: 30000 });
try {
  const page = await browser.newPage();
  await page.setContent('<p>Proser publication renderer verification</p>');
  const pdf = await page.pdf();
  if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Publication renderer did not produce a PDF.');
  console.log(JSON.stringify({ status: 'ready', browserVersion: browser.version(), executable: chromium.executablePath(), pdfBytes: pdf.length }));
} finally {
  await browser.close();
}
