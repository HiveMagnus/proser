import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const config = parseEnv(readFileSync(process.argv[2], "utf8"));
const author = `http://localhost:${config.PROSER_WEB_PORT}`;
const factory = `http://127.0.0.1:${config.PROSER_FACTORY_PORT}`;
assert.equal(config.PROSER_ORIGIN, author);
assert.equal(config.LOCAL_AUTH_USERNAME, "author");

async function request(base, path, options) {
  return fetch(base + path, { signal: AbortSignal.timeout(20000), ...options });
}

async function signIn() {
  const csrf = await request(author, "/api/auth/csrf");
  assert(csrf.ok, "Author did not provide a CSRF token");
  const cookies = new Map(
    csrf.headers
      .getSetCookie()
      .map((entry) => [entry.split("=", 1)[0], entry.split(";", 1)[0]]),
  );
  const { csrfToken } = await csrf.json();
  const response = await request(author, "/api/auth/callback/iam", {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: [...cookies.values()].join("; "),
    },
    body: new URLSearchParams({
      csrfToken,
      username: config.LOCAL_AUTH_USERNAME,
      password: config.LOCAL_AUTH_PASSWORD,
      callbackUrl: author + "/",
    }),
  });
  const cookie = response.headers
    .getSetCookie()
    .find((entry) => entry.startsWith("authjs.session-token="));
  assert(cookie, "Author sign-in did not issue a session");
  return cookie.split(";", 1)[0];
}

function factoryCredential() {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    iss: "proser-author",
    aud: "proser-factory",
    sub: "iam:author",
    githubId: "iam:author",
    username: "author",
    iat: now,
    exp: now + 60,
  });
  const signature = createHmac("sha256", config.FACTORY_AUTH_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `Bearer ${header}.${payload}.${signature}`;
}

async function api(base, path, headers, payload, status = 200) {
  const response = await request(
    base,
    path,
    payload
      ? {
          method: "POST",
          headers: {
            ...headers,
            origin: author,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      : { headers },
  );
  assert.equal(response.status, status, path);
  const envelope = await response.json();
  assert(envelope.success, path);
  return envelope.data;
}

for (const base of [author, factory]) {
  assert.equal((await api(base, "/api/readiness", {})).ready, true);
  assert.equal((await request(base, "/api/books")).status, 401);
}

const title = `Compose image smoke ${randomUUID()}`;
const text =
  "A synthetic manuscript paragraph persisted through the public image.";
const cookie = await signIn();
const book = await api(
  author,
  "/api/books",
  { cookie },
  { title, operationId: randomUUID() },
  201,
);
const path = `/api/books/${book.id}`;
const head = await api(author, `${path}/document-manifest`, { cookie });
const draft = await api(
  author,
  `${path}/document-quick-drafts`,
  { cookie },
  {
    schemaVersion: 1,
    operationId: randomUUID(),
    expectedRevisionId: head.revisionId,
    expectedScopes: { structure: head.scopes.structure.revisionId },
    summary: "Release smoke test",
    outline: "Save a synthetic scene.",
  },
  201,
);
const documentPath = `${path}/scenes/${draft.result.sceneId}/document`;
const scene = await api(author, documentPath, { cookie });
scene.document.blocks[0].runs[0].text = text;
await api(
  author,
  `${path}/document-commits`,
  { cookie },
  {
    schemaVersion: 1,
    operationId: randomUUID(),
    expectedRevisionId: scene.bookRevisionId,
    scenes: [
      {
        sceneId: scene.sceneId,
        expectedRevisionId: scene.revisionId,
        document: scene.document,
      },
    ],
  },
);
const reopened = await signIn();
assert.equal((await api(author, path, { cookie: reopened })).title, title);
assert.equal(
  (await api(author, documentPath, { cookie: reopened })).projection.text,
  text,
);
assert.equal(
  (await api(factory, documentPath, { authorization: factoryCredential() }))
    .projection.text,
  text,
);
console.log(
  "Author sign-in, synthetic manuscript save and reopen, and protected Factory access passed.",
);
