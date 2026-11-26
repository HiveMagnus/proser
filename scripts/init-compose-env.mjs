import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

// node scripts/init-compose-env.mjs [<file> | -]
// Writes a new environment file with generated credentials (default
// .env.compose, never overwriting one). "-" prints it to standard output, so a
// prebuilt-image install can run this from the image without Git or Node:
//   (umask 077; docker run --rm <image> node scripts/init-compose-env.mjs - > .env.compose)
const secret = () => randomBytes(32).toString("hex");
let revision = "";
try {
  revision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // Only source builds use the revision; prebuilt images carry their own.
}
const output = process.argv[2] ?? ".env.compose";
const content = [
  "COMPOSE_FILE=compose.yml:compose.factory-api.yml",
  ...(revision ? [`PROSER_REVISION=${revision}`] : []),
  "PROSER_ORIGIN=http://localhost:3000",
  "PROSER_FACTORY_BIND=127.0.0.1",
  `PROSER_DB_PASSWORD=${secret()}`,
  `NEXTAUTH_SECRET=${secret()}`,
  `FACTORY_AUTH_SECRET=${secret()}`,
  `INTERNAL_API_SECRET=${secret()}`,
  `METRICS_TOKEN=${secret()}`,
  "LOCAL_AUTH_USERNAME=author",
  `LOCAL_AUTH_PASSWORD=${secret()}`,
  "",
].join("\n");
if (output === "-") {
  process.stdout.write(content);
  console.error(
    "Printed a new environment with generated credentials and loopback Factory access. Save it with owner-only permissions.",
  );
} else {
  writeFileSync(output, content, { flag: "wx", mode: 0o600 });
  console.log(
    `Created ${output} with generated credentials and loopback Factory access.`,
  );
}
