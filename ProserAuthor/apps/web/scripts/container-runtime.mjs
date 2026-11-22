import { createHmac } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const dist = new URL('../.next/', import.meta.url);
const prerenderPath = new URL('prerender-manifest.json', dist);
const previewPath = new URL('server/preview-props.json', dist);
const referencePath = new URL('server/server-reference-manifest.json', dist);
const referenceScript = new URL('server/server-reference-manifest.js', dist);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const preparing = process.argv[2] === '--prepare';

function replaceFile(path, content) {
  const temporary = new URL(`${path.href}.proser-tmp`);
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}

function configure(preview, encryptionKey) {
  const prerender = readJson(prerenderPath);
  const references = readJson(referencePath);
  if (Object.keys(references.node).length || Object.keys(references.edge).length) {
    throw new Error('The container build has unexpected Next.js server actions');
  }
  if (preparing) {
    const props = readJson(previewPath);
    const script = readFileSync(referenceScript, 'utf8');
    if (
      !references.encryptionKey ||
      !script.includes(references.encryptionKey) ||
      Object.keys(preview).some((key) => !props[key] || props[key] !== prerender.preview[key])
    ) {
      throw new Error('Unexpected Next.js container manifest structure');
    }
  }

  const manifest = JSON.stringify({ ...references, encryptionKey });
  replaceFile(prerenderPath, JSON.stringify({ ...prerender, preview }));
  replaceFile(previewPath, JSON.stringify(preview));
  replaceFile(referencePath, manifest);
  replaceFile(referenceScript, `self.__RSC_SERVER_MANIFEST = ${JSON.stringify(manifest)}\n`);
}

if (preparing) {
  // Runtime manifests have placeholders in the registry image. Build cache can
  // contain the original per-build values and has no role in the web server.
  rmSync(new URL('cache/', dist), { recursive: true, force: true });
  configure(
    {
      previewModeId: '0'.repeat(32),
      previewModeSigningKey: '1'.repeat(64),
      previewModeEncryptionKey: '2'.repeat(64),
    },
    Buffer.alloc(32).toString('base64'),
  );
} else {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET is required to start Author');
  const derive = (label) => createHmac('sha256', secret).update(`Proser Next container ${label}`);
  configure(
    {
      previewModeId: derive('preview id').digest('hex').slice(0, 32),
      previewModeSigningKey: derive('preview signing').digest('hex'),
      previewModeEncryptionKey: derive('preview encryption').digest('hex'),
    },
    derive('server actions encryption').digest('base64'),
  );
  await import('../server.js');
}
