/**
 * CLI user resolution — extracts CLI user creation/lookup from create.ts
 * so other commands (pipeline, list, etc.) can also resolve a user.
 * @module cli/auth
 */
import type { PrismaClient } from '@prisma/client';

const CLI_GITHUB_ID = 'cli-local-user';

/**
 * Resolve the CLI user. If `userIdOverride` is provided, returns it directly
 * (caller is responsible for validity). Otherwise upserts the default CLI
 * local user and returns its ID.
 */
export async function resolveCliUser(
  db: PrismaClient,
  userIdOverride?: number,
): Promise<{ id: number }> {
  if (userIdOverride) {
    return { id: userIdOverride };
  }

  const user = await db.user.upsert({
    where: { githubId: CLI_GITHUB_ID },
    update: {},
    create: {
      githubId: CLI_GITHUB_ID,
      username: 'cli',
      email: 'cli@proser.local',
    },
  });

  return { id: user.id };
}
