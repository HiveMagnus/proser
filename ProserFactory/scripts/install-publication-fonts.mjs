#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
const target = process.argv[2];
if (!target || !path.isAbsolute(target))
  throw new Error('Usage: node install-publication-fonts.mjs /absolute/release/font-directory');
const pins = JSON.parse(
  await readFile(new URL('../config/publication-font-pins.json', import.meta.url), 'utf8'),
);
const staging = await mkdtemp(path.join(os.tmpdir(), 'proser-publication-fonts-'));
const fonts = [];
try {
  for (const pin of pins.fonts) {
    const archive = path.join(staging, `${pin.name}.archive`);
    execFileSync(
      'curl',
      [
        '--fail',
        '--location',
        '--max-time',
        '60',
        '--retry',
        '2',
        '--output',
        archive,
        pin.distribution,
      ],
      { stdio: 'inherit' },
    );
    const bytes = await readFile(archive);
    if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256)
      throw new Error(`Font distribution ${pin.name} checksum mismatch.`);
    const extracted = path.join(staging, pin.name);
    await mkdir(extracted);
    execFileSync('tar', ['-xf', archive, '-C', extracted], { stdio: 'inherit' });
    const root = path.join(extracted, (await readdir(extracted))[0]);
    const release = path.join(target, `${pin.name}-${pin.version}`);
    await mkdir(release, { recursive: true, mode: 0o755 });
    const licensePath = path.join(release, 'LICENSE');
    await copyFile(path.join(root, 'LICENSE'), licensePath);
    const source = pin.name === 'DejaVu' ? path.join(root, 'ttf') : root;
    for (const filename of (await readdir(source)).filter((name) => name.endsWith('.ttf')).sort()) {
      const fontPath = path.join(release, filename);
      await copyFile(path.join(source, filename), fontPath);
      const family = filename
        .replace(/\.ttf$/, '')
        .replace(/-.*$/, '')
        .replace(/^Liberation(Serif|Sans|Mono)$/, 'Liberation $1')
        .replace(/^DejaVu(Serif|Sans|SansMono)$/, 'DejaVu $1')
        .replace('SansMono', 'Sans Mono');
      fonts.push({
        name: family,
        version: pin.version,
        path: fontPath,
        sha256: createHash('sha256')
          .update(await readFile(fontPath))
          .digest('hex'),
        licensePath,
        license: pin.license,
        upstream: pin.upstream,
        distributionSha256: pin.sha256,
      });
    }
  }
  const manifest = path.join(target, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, fonts }, null, 2) + '\n', {
    mode: 0o644,
  });
  process.stdout.write(`PUBLICATION_FONT_MANIFEST=${manifest}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
