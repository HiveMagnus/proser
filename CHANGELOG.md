# Changelog

Notable changes to Proser. Releases up to v1.0.7 are described on
[GitHub Releases](https://github.com/HiveMagnus/proser/releases). Upgrade steps
are in the [Compose guide](docs/COMPOSE.md#upgrades-and-recovery).

## Unreleased

### Security

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

### Trash

- The Dashboard lists deleted books under **Deleted books** and restores one
  with **Restore**, back to the revision just before it was deleted (scenes,
  Story Bible and layout). `GET /api/books/trash` lists them with the revision
  to pass to the existing book-revision restore route. Installs with document
  authority off still delete books outright.

### Changes

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
- New Factory routes: `GET /api/books/:bookId/writing-stats`,
  `PUT /api/books/:bookId/writing-goal`,
  `GET /api/books/:bookId/recommendations` and `GET /api/plot/archetypes`.

### Upgrade notes

- If writers open Proser at an address other than `PROSER_ORIGIN`, writes from
  that address are still accepted when the browser's `Origin` matches the
  `Host` the request reached. A reverse proxy that rewrites `Host` must pass
  `X-Forwarded-Host`, or `PROSER_ORIGIN` must name the address writers use.
- Hermes agents that call Factory with a `pnv_` service-principal token now
  share one rate-limit bucket per client address.
- The Compose `worker` service now has a healthcheck. Use this release's
  `compose.yml` with its image; an older image has no healthcheck command and
  would show as unhealthy.
- Releases must set the root and `ProserFactory/package.json` versions to the
  tag before tagging; the publish workflow checks it.
- **Database migration:** `20261126000000_book_writing_goals` adds the
  `book_writing_goals` table. Existing Compose installs stop at `initialize`
  until it is applied with the documented `migrate deploy` command.
