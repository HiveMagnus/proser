import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const secret = () => randomBytes(32).toString("hex");
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const output = process.argv[2] ?? ".env.compose";
writeFileSync(
  output,
  [
    "COMPOSE_FILE=compose.yml:compose.factory-api.yml",
    `PROSER_REVISION=${revision}`,
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
  ].join("\n"),
  { flag: "wx", mode: 0o600 },
);
console.log(
  `Created ${output} with generated credentials and loopback Factory access.`,
);
