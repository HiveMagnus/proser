FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl g++ make openssl python3 && rm -rf /var/lib/apt/lists/*
RUN npm install --global corepack@0.36.0 && corepack enable
WORKDIR /opt/proser

COPY ProserFactory/package*.json ProserFactory/prisma.config.ts ./factory/
COPY ProserFactory/prisma ./factory/prisma
COPY ProserFactory/vendor/deepmerge ./factory/vendor/deepmerge
RUN cd factory && npm ci && npm run db:generate
COPY ProserFactory/src ./factory/src
COPY ProserFactory/tsconfig*.json ./factory/
COPY ProserFactory/scripts/build.mjs ProserFactory/scripts/check-word-codec.cjs ./factory/scripts/
COPY ProserFactory/config ./factory/config
COPY ProserFactory/evaluation ./factory/evaluation
COPY ProserFactory/vendor/unicode ./factory/vendor/unicode
RUN cd factory && npm run build && npm prune --omit=dev

COPY ProserAuthor/package.json ProserAuthor/pnpm-lock.yaml ProserAuthor/pnpm-workspace.yaml ProserAuthor/turbo.json ProserAuthor/tsconfig.json ./author/
COPY ProserAuthor/apps/web ./author/apps/web
COPY ProserAuthor/packages ./author/packages
RUN cd author && corepack pnpm install --frozen-lockfile && corepack pnpm build \
    && find . -type d -name .turbo -prune -exec rm -r {} + \
    && node apps/web/scripts/container-runtime.mjs --prepare

FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
WORKDIR /opt/proser
COPY LICENSE NOTICE ./
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PROSER_AUTHOR_CONTAINER=true \
    PLAYWRIGHT_BROWSERS_PATH=/opt/proser/browsers \
    PUBLICATION_FONT_MANIFEST=/opt/proser/fonts/manifest.json
COPY --from=build /opt/proser/factory /opt/proser/factory
COPY ProserFactory/scripts/install-publication-fonts.mjs ./factory/scripts/
COPY ProserFactory/deploy/document-authority/enforcement.sql ./factory/deploy/document-authority/
COPY scripts/initialize-compose-database.mjs ./factory/scripts/
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl openssl lbzip2 xz-utils \
    && cd factory && node node_modules/playwright/cli.js install --with-deps chromium \
    && node scripts/install-publication-fonts.mjs /opt/proser/fonts \
    && install -d -o node -g node -m 0700 data public/images \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/proser/author /opt/proser/author
RUN install -d -o node -g node -m 0700 /opt/proser/author/apps/web/.next/cache
RUN cd /opt/proser/author/apps/web/.next \
    && chown node:node . server prerender-manifest.json server/preview-props.json \
        server/server-reference-manifest.json server/server-reference-manifest.js
ARG PROSER_REVISION
LABEL org.opencontainers.image.revision=$PROSER_REVISION
RUN test "${#PROSER_REVISION}" -eq 40 && printf '%s\n' "$PROSER_REVISION" | grep -Eq '^[a-f0-9]{40}$' \
    && printf '%s\n' "$PROSER_REVISION" > /opt/proser/factory/REVISION
USER node
WORKDIR /opt/proser/factory
CMD ["node", "dist/index.js"]
