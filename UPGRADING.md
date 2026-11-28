# Upgrading Proser

This file lists what an operator must do when moving a Compose installation to
a newer release. The general procedure (back up, switch the checkout and
`PROSER_IMAGE`, apply migrations, start) is in the
[Compose guide](docs/COMPOSE.md#upgrades-and-recovery); release changes are in
[CHANGELOG.md](CHANGELOG.md).

## Every upgrade

1. Run `scripts/backup-compose.sh --env-file .env.compose` and keep the backup
   private.
2. Check out the release tag that matches the new image, so `compose.yml` and
   the scripts match it. Keep `.env.compose`, the project name and the named
   volumes.
3. Set `PROSER_IMAGE` to the new image and `docker pull` it.
4. If the `initialize` service reports pending migrations, apply them with the
   new image (`… run --rm --no-deps initialize node node_modules/prisma/build/index.js migrate deploy`),
   then start the stack with `up -d --no-build --wait`.
5. Check `docker compose ps` (Author, Factory and the worker are `healthy`),
   both readiness URLs, and the version on the Settings page.

## v1.2.2

- **Local sign-in:** throttling and the trusted-proxy source address now come
  from `@hivemagnus/hive-common`. `LOCAL_AUTH_TRUSTED_PROXY_HOPS`,
  `LOCAL_AUTH_TRUSTED_PROXY_PEERS` and the limits are unchanged, so there is
  nothing to configure. The behavior differences are listed in
  [CHANGELOG.md](CHANGELOG.md#v122-2026-11-28).
- **Database:** no migration in this release; the document enforcement guards
  are unchanged. To roll back, run the v1.2.1 image with its settings.

## v1.2.1

v1.2.0 was tagged but never published, so upgrade from v1.1.0 straight to
v1.2.1. These notes cover the whole step from v1.1.0.

- **Oathweave sign-in:** the password relay is removed. If `IAM_CORE_URL` is
  set, configure Oathweave OIDC (`OATHWEAVE_OIDC_*`,
  [guide](docs/OATHWEAVE_OIDC.md)) before upgrading, keep `IAM_CORE_URL` set,
  and remove `OATHWEAVE_PASSWORD_RELAY`. Installations already on OIDC with
  the relay off need no change. Accounts already linked to an Oathweave `sub`
  keep their books; unlinked relay accounts are linked by username on the
  first OIDC sign-in.
- **Relay callback:** on an installation that sets `IAM_CORE_URL`, a request
  to the removed relay's callback `/api/auth/callback/iam` gets `410 Gone`
  (`PASSWORD_RELAY_REMOVED`). Move anything that still posts passwords there
  to Oathweave OIDC sign-in.
- **Container image:** npm, npx, Corepack and Yarn are no longer in the image.
  Commands you run inside a Proser container must call `node` directly, as the
  documented `migrate deploy` does.
- **Database:** no migration in this release; the document enforcement guards
  are unchanged. To roll back, run the v1.1.0 image with its settings.

## v1.2.0 (not published)

This tag has no image. Use v1.2.1, whose notes include its changes.

## v1.1.0

- **Compose file:** the `worker` service has a healthcheck that runs a command
  shipped in this release's image. Use the release's `compose.yml` with its
  image; with an older image the worker shows as unhealthy.
- **Cross-site requests:** Author refuses writes whose browser `Origin` is not
  the Proser origin. If writers reach Proser at an address other than
  `PROSER_ORIGIN` through a proxy that rewrites `Host`, pass
  `X-Forwarded-Host` or set `PROSER_ORIGIN` to that address.
- **Restores:** `scripts/restore-compose.sh` refuses a backup taken with an
  image other than `PROSER_IMAGE` unless you pass `--allow-image-mismatch`, and
  keeps the replaced database as `proser_previous_<time>` until you drop it.
- **Database migration:** `20261127100000_oathweave_subject` adds the nullable,
  unique `users.oathweave_subject` column that Oathweave OIDC accounts are keyed
  on. It is additive: existing accounts and sign-ins are unchanged, and an
  earlier image ignores the column. Apply it with `migrate deploy` (step 4).
- **Oathweave OIDC sign-in (optional):** nothing changes until you set
  `OATHWEAVE_OIDC_ISSUER` and `OATHWEAVE_OIDC_CLIENT_ID`. Register Proser in
  Oathweave first ([guide](docs/OATHWEAVE_OIDC.md)); its callback is
  `<PROSER_ORIGIN>/api/auth/callback/oathweave`. The password relay stays on.
  After OIDC works, set `OATHWEAVE_PASSWORD_RELAY=false` (and keep
  `IAM_CORE_URL`) to stop relaying passwords.
- **Database migration:** `20261126000000_book_writing_goals` adds the
  `book_writing_goals` table. `initialize` stops with the pending migration
  name until you apply it with `migrate deploy` (step 4 above). The document
  enforcement guards are unchanged.
- **Database migration:** `20261127000000_book_ai_policies` adds the
  `book_ai_policies` table for the per-book AI switch. It is applied by the
  same `migrate deploy` step. Existing books keep AI on; nothing else changes
  until a writer switches AI off for a book.

## v1.0.6 and v1.0.7

Upgrade notes for these and earlier releases are in the
[GitHub release notes](https://github.com/HiveMagnus/proser/releases).
