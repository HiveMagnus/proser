import * as dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

// Mirror the app's file load order without replacing an explicit process-level
// DATABASE_URL supplied by CI, deploy scripts, or one-off migration checks.
const inheritedDatabaseUrl = process.env.DATABASE_URL;
dotenv.config();
dotenv.config({ path: '.env.local', override: true });
if (inheritedDatabaseUrl) process.env.DATABASE_URL = inheritedDatabaseUrl;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Use direct env access to avoid hard failure for commands that don't need DB access.
    url: process.env.DATABASE_URL ?? '',
  },
});
