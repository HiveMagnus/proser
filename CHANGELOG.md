# Changelog

Notable changes to Proser. Releases up to v1.0.7 are described on
[GitHub Releases](https://github.com/HiveMagnus/proser/releases). Upgrade steps
are in the [Compose guide](docs/COMPOSE.md#upgrades-and-recovery).

## Unreleased

### Sign-in

- The Oathweave password relay is removed. Proser no longer takes an
  Oathweave writer's password or posts it to Oathweave's login API: Oathweave
  writers sign in only through Oathweave OpenID Connect (authorization code with
  S256 PKCE), where passwords, second factors and passkeys are entered at
  Oathweave. `OATHWEAVE_PASSWORD_RELAY` has no effect and Author warns while it
  is set. Local and GitHub accounts are unchanged.
- **Upgrade note:** an installation that sets `IAM_CORE_URL` must configure
  `OATHWEAVE_OIDC_*` before upgrading, or Oathweave writers cannot sign in
  (Author logs the reason at startup). Installations that already set
  `OATHWEAVE_PASSWORD_RELAY=false` with OIDC see no change. See
  [Upgrading from the password relay](docs/OATHWEAVE_OIDC.md#upgrading-from-the-password-relay).

## v1.1.0 (2026-11-26)

### Sign-in

- Proser can sign writers in through Oathweave with OpenID Connect
  (authorization code with S256 PKCE and a nonce). Passwords and second
  factors are entered at Oathweave and never reach Proser. Author verifies the
  ID token's signature against Oathweave's published keys and keeps no
  Oathweave tokens in its session. Configure it with `OATHWEAVE_OIDC_ISSUER`
  and `OATHWEAVE_OIDC_CLIENT_ID`, plus a discovery URL or explicit endpoints.
  Oathweave's native discovery needs `IAM_PUBLIC_URL` on the Oathweave side.
  See [the Oathweave OIDC guide](docs/OATHWEAVE_OIDC.md) for the client
  registration.
- Factory keys Oathweave OIDC accounts on the Oathweave `sub`. The first OIDC
  sign-in links the account the password relay created for the same username,
  so existing books stay with the writer. Later sign-ins survive an Oathweave
  username change. An account linked to one Oathweave user is never handed to
  another user who reuses its username.
- The password relay (`IAM_CORE_URL`) keeps working as a fallback and stays on
  by default. `OATHWEAVE_PASSWORD_RELAY=false` turns it off once OIDC is
  configured, and is ignored while OIDC is not. Local and GitHub accounts are
  unchanged.
- A refused Oathweave or GitHub sign-in now returns to the Proser sign-in page
  with a message instead of the Auth.js error page.

### Security

- The manuscript editor uses `@hivemagnus/canvas-word-engine` 1.2.2. HTML
  pasted into the editor is sanitized and never parsed again in the live
  document, so markup that changes shape when reparsed can no longer run
  script in the Proser page. Upgrade note: pasted inline SVG and MathML, and
  the content of `template`, `xmp`, `noembed`, `noframes` and `plaintext`
  elements, are no longer imported.
- Author refuses `POST`, `PUT`, `PATCH` and `DELETE` requests to `/api/*` whose
  `Origin` is not the Proser origin (`AUTH_URL`, `NEXTAUTH_URL` or the host the
  request was sent to), or whose `Sec-Fetch-Site` reports another site. A page
  on a sibling host under the same parent domain can no longer act with the
  writer's session cookie.
- Author pages send a Content-Security-Policy with a per-request script nonce:
  scripts and connections stay on the Proser origin, and images come only from
  Proser, `data:`/`blob:` URLs and GitHub avatars. Every page now renders per
  request.
- The global API rate limit counts a request against an identity only after the
  token's signature and claims verify. Requests without a valid token, and
  service-principal tokens, count against the client address, so a forged token
  can no longer use up a writer's allowance.
- `GET /api/books/:bookId/creative-package` validates its parameters, checks
  book ownership first and takes the same capacity budget as `/export`
  (2 concurrent per user, 1 per book, 100 a day per user, 30 a day per book).
- Earlier on main (#26, #27): keyless non-loopback inference hosts no longer
  stop Factory, stored cloud API keys are removed and never returned, and
  Oathweave accounts with MFA can sign in.

### Fixes

- Signing out checks the browser for drafts Proser has not saved. When there
  are any, Author lists them and offers to download them, remove every Proser
  draft and recovery journal from the browser (for shared devices), or keep
  them for the next sign-in.
- A scene draft or passage whose save Factory never confirmed is no longer
  deleted after 30 days; it stays until the writer recovers, downloads or
  discards it.
- The release image builds again: `.dockerignore` now passes
  `scripts/init-compose-env.mjs`, which the Dockerfile copies into the image.
  A root test checks every Dockerfile `COPY` source against the build context.

### Backup and restore

- `scripts/restore-compose.sh` checks that the dump is readable before
  changing anything, restores into a staging database and staging directories,
  and replaces the installation's data only when all of it was staged. The
  previous database is kept as `proser_previous_<time>`. A backup taken with an
  image other than `PROSER_IMAGE` is refused unless `--allow-image-mismatch` is
  given.
- `scripts/backup-compose.sh` stops if it cannot list the running services,
  instead of copying while the writers keep running.
- A configured `pnv_` service-principal token counts against its principal in
  the global rate limit; unknown ones count against the client address.
- Writing goals refuse impossible dates such as 2026-02-30, and writing
  statistics refuse a time zone PostgreSQL does not know, with `422` instead
  of a server error.

### Operations

- Release images record their version; Factory reports it from `/health`,
  `GET /api` and `GET /api/settings/about`, and Settings shows it with the
  revision. `/health` previously always said `1.0.0`.
- The Compose `worker` service has a healthcheck, so `docker compose ps` shows
  a worker whose queue consumers stopped.
- `/api/readiness` reuses a successful editorial corpus check for five minutes
  instead of re-reading the corpus on every probe.
- `scripts/init-compose-env.mjs` no longer needs Git and can print to standard
  output, so a prebuilt install can generate `.env.compose` from the image.
- The release workflow rehearses backup and restore and upgrades an
  installation of the previous release to the candidate image before
  publishing it.
- Release images are published for `linux/arm64` as well as `linux/amd64`.
  Each architecture is built and tested on a native runner, and the version
  tag is a manifest list, so `docker pull` picks the host's architecture.
  Running the publish workflow by hand is a dry run that publishes nothing.

### Trash

- The Dashboard lists deleted books under **Deleted books** and restores one
  with **Restore**, back to the revision just before it was deleted (scenes,
  Story Bible and layout). `GET /api/books/trash` lists them with the revision
  to pass to the existing book-revision restore route. Installs with document
  authority off still delete books outright.

### Changes

- Dependabot now opens one grouped weekly pull request (group `hivemagnus`) for `@hivemagnus/*` package updates, so suite package bumps arrive together. Repository configuration only; nothing to do when upgrading.
- New [Writing with Proser](docs/WRITING_WITH_PROSER.md) guide for writers,
  linked from the README, and [UPGRADING.md](UPGRADING.md) for operators.
- `node dist/operations/imageOrphanSweep.js` in the Factory container reports
  image files no image record references, and removes them with `--apply`
  (files younger than 24 hours are left alone).
- The export used when document authority is off (native installs) sends
  `Cache-Control: private, no-store` and a SHA-256 ETag instead of a public
  60-second cache and a weak ETag, no longer caches manuscripts in Redis, and
  drops an unreachable PDF branch that needed Puppeteer.
- Author no longer keeps Oathweave access and refresh tokens in the session
  cookie; nothing used them.
- The `CANVAS_*.md` release-process documents moved to `docs/`, the Author
  workspace packages are named `@hivemagnus/proser-*`, and two stray Factory
  scripts were removed.

### Writing view

- **Focus mode** in the desktop Manuscript hides the sidebar, top bar and
  banners (the **Focus** button or Ctrl/⌘+Shift+F), and **Typewriter** keeps
  the line being typed in the middle of the screen. Both settings are kept
  per browser.

### New features

- **Portable book archive.** Publish has a **Book archive** section: download the
  whole book as one versioned ZIP (`proser-book-archive` v1: manuscript with
  formatting, open comments and pending changes, codex and scene links, notes,
  plot threads, goal, AI switch, layout, styles, front and back matter, and
  images, with a SHA-256 for every file), and import an archive from another
  install as a new book (`GET /api/books/:bookId/archive`,
  `POST /api/books/archive-imports`). Import checks every digest before it
  writes, never changes an existing book, keeps the AI switch, and a retry
  returns the same book. It carries the current version only: earlier revisions
  are not included, resolved tracked changes are applied to the text, resolved
  comments are dropped, and comments and pending changes become the importing
  writer's.
- **Writing statistics and goals.** The Analytics page (back in the sidebar)
  shows words in the book, words written per day over 7, 30 and 90 days, the
  best day and the writing streak, from the saved book revisions in the
  writer's time zone. Words from imports, AI and workflows are counted
  separately. A book can have a length target, a deadline and a daily goal;
  Analytics shows the pace needed and the Dashboard shows the streak.
- **Next steps.** The Dashboard and a banner suggest what to do next for the
  open book (first scene, empty scenes, today's goal, deadline pace, Story
  Bible, archetype).
- **Story archetypes.** Plot Studio shows the book's archetype and the full
  list from Factory. Author now reads a book's archetype from Factory's
  `storyArchetypeKey`, so the Dashboard shows it. The unused demo page at
  `/plot/<id>` with sample beats is removed.
- **Import a Markdown or text manuscript.** Publish has a new **Import a
  Markdown or text manuscript** section for `.md` and `.txt` files. Chapter
  headings (`## Chapter 1`, or a `Chapter One` line in a text file) start
  chapters, `Part` headings start parts, and scene-break lines such as `***`
  start scenes. Like the bundle and DOCX imports, Factory keeps the exact file,
  shows the chapter mapping and what the conversion changes, and appends the
  chapters only after the writer consents to that report. Text files that are
  not UTF-8 are read as Windows-1252, and the report says so.
  `POST /api/books/:bookId/import-originals/:originalId` takes
  `?format=markdown` or `?format=plain-text`; without it the upload is a legacy
  bundle as before. No database migration.
- New Factory routes: `GET /api/books/:bookId/writing-stats`,
  `PUT /api/books/:bookId/writing-goal`,
  `GET /api/books/:bookId/recommendations` and `GET /api/plot/archetypes`.
- **Find and replace across the book.** The desktop Manuscript has a **Find
  and replace** panel: it previews every match in the saved manuscript with
  its context, lets the writer untick matches to keep, and saves the rest as
  one book revision. **Undo replace** restores the revision before it while
  nothing else has been saved since. Matches that cross formatting, a
  paragraph or a pending tracked change are listed but skipped. A replace
  covers at most 1000 matches in 100 scenes; preview again for the rest. New
  Factory routes: `POST /api/books/:bookId/document-replace/preview` and
  `POST /api/books/:bookId/document-replace`.
- **Keep a book away from AI.** Edit Details on the Dashboard has a per-book
  switch, and such books show an **AI off** badge. Factory enforces it: every
  request that would send the book to a model provider (generation, revision,
  review, proposals, campaigns, plot-thread reviews, workflows, image
  generation, Hermes and Nova routes) is refused with `409 BOOK_AI_DISABLED`
  before the provider is called. Queued workflows pause and live judging
  stops; retrieval skips embeddings and uses keyword search. Changes are
  recorded in the audit log. New routes:
  `GET`/`PUT /api/books/:bookId/ai-policy` and `GET /api/books/ai-policies`.

### Install on a phone

- Author publishes a web manifest and home-screen icons, so Proser can be added
  to a phone's home screen and opens standalone on the mobile home.
- Production builds register a small offline service worker. Opening Proser
  with no connection shows an offline page that explains unsaved drafts stay on
  the device. The worker stores only the offline page, the icons and the
  manifest; it never caches pages, `/api/*` or sign-in responses.

### Upgrade notes

- Book archive imports send up to 128 MiB in one request. A reverse proxy in
  front of Proser must allow request bodies that large (for nginx,
  `client_max_body_size 128m;`) for imports of large illustrated books.
- If writers open Proser at an address other than `PROSER_ORIGIN`, writes from
  that address are still accepted when the browser's `Origin` matches the
  `Host` the request reached. A reverse proxy that rewrites `Host` must pass
  `X-Forwarded-Host`, or `PROSER_ORIGIN` must name the address writers use.
- The Compose `worker` service now has a healthcheck. Use this release's
  `compose.yml` with its image; an older image has no healthcheck command and
  would show as unhealthy.
- Releases must set the root and `ProserFactory/package.json` versions to the
  tag before tagging; the publish workflow checks it.
- Release image tags are now manifest lists covering `linux/amd64` and
  `linux/arm64`; the version tag's digest is the list's digest. Pin that
  digest, not a `-amd64` or `-arm64` staging tag. Pi-class and Apple-silicon
  hosts can use releases after v1.0.7.
- **Database migration:** `20261127000000_book_ai_policies` adds the
  `book_ai_policies` table (no rows means AI stays on for every book). Apply it
  with the same `migrate deploy` step as the writing-goals migration.
- **Database migration:** `20261126000000_book_writing_goals` adds the
  `book_writing_goals` table. Existing Compose installs stop at `initialize`
  until it is applied with the documented `migrate deploy` command.
