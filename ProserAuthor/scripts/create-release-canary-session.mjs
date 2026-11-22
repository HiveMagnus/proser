#!/usr/bin/env node
/** Operator-only disposable session fixture. Does not change IAM or providers. */
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFile, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
const argumentsList = process.argv.slice(2);
const argument = (name) => {
  const index = argumentsList.indexOf(name);
  return index < 0 ? undefined : argumentsList[index + 1];
};
const environmentFile = argument('--env-file'),
  output = argument('--out'),
  username = argument('--username');
if (
  !environmentFile ||
  !path.isAbsolute(environmentFile) ||
  !output ||
  !path.isAbsolute(output) ||
  !/^release-canary-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(username ?? '')
)
  throw new Error(
    'Supply an absolute private environment/output and a new release-canary-UUID identity.',
  );
for (const filename of [environmentFile, path.dirname(output)]) {
  const info = await lstat(filename);
  if (
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    info.mode & 0o077 ||
    (filename === environmentFile && !info.isFile()) ||
    (filename !== environmentFile && !info.isDirectory())
  )
    throw new Error(
      'Environment and output directory must be private, regular and owned by the operator.',
    );
}
const fields = new Map();
for (const line of (await readFile(environmentFile, 'utf8')).split(/\r?\n/)) {
  const entry = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (!entry) continue;
  let value = entry[2];
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )
    value = value.slice(1, -1);
  fields.set(entry[1], value);
}
const secret = fields.get('AUTH_SECRET') || fields.get('NEXTAUTH_SECRET');
if (!secret) throw new Error('A configured Author session secret is required.');
const origin = new URL(fields.get('AUTH_URL') || fields.get('NEXTAUTH_URL') || 'http://invalid');
if (
  !['https:', 'http:'].includes(origin.protocol) ||
  (!['localhost', '127.0.0.1'].includes(origin.hostname) &&
    (origin.protocol !== 'https:' || origin.origin !== process.env.PROSER_AUTHOR_ORIGIN))
)
  throw new Error('Only the configured Proser origin or isolated loopback fixtures are accepted.');
const secure = origin.protocol === 'https:',
  name = `${secure ? '__Secure-' : ''}authjs.session-token`;
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { encode, decode } = await import(pathToFileURL(require.resolve('next-auth/jwt')).href);
const maxAge = 1200,
  token = {
    sub: username,
    name: 'Disposable release canary',
    username,
    provider: 'release-fixture',
    roles: ['author'],
  };
const value = await encode({ token, secret, salt: name, maxAge });
const decoded = await decode({ token: value, secret, salt: name });
if (decoded?.sub !== username || decoded?.provider !== 'release-fixture')
  throw new Error('Session fixture cryptographic verification failed.');
await writeFile(
  output,
  JSON.stringify(
    {
      schemaVersion: 1,
      kind: 'disposable-signed-author-session',
      identity: username,
      factoryIdentity: `release-fixture:${username}`,
      iamPasswordLogin: 'unverified',
      createdAt: new Date().toISOString(),
      cookie: {
        name,
        value,
        url: origin.origin,
        secure,
        httpOnly: true,
        sameSite: 'Lax',
        expires: Math.floor(Date.now() / 1000) + maxAge,
      },
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx', mode: 0o600 },
);
process.stdout.write(
  JSON.stringify({
    status: 'created',
    identity: username,
    output: fileURLToPath(pathToFileURL(output)),
    iamPasswordLogin: 'unverified',
    sessionLifetimeSeconds: maxAge,
  }) + '\n',
);
