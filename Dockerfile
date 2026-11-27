FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
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

FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime
# Nothing in the runtime image runs a package manager, so the base image's npm,
# npx, Corepack and Yarn are removed with the vulnerability findings they bring.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-v* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/yarn /usr/local/bin/yarnpkg
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
COPY scripts/initialize-compose-database.mjs scripts/init-compose-env.mjs ./factory/scripts/
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
# Release builds pass the tag version; source builds report the package version.
ARG PROSER_VERSION=
LABEL org.opencontainers.image.revision=$PROSER_REVISION
RUN test "${#PROSER_REVISION}" -eq 40 && printf '%s\n' "$PROSER_REVISION" | grep -Eq '^[a-f0-9]{40}$' \
    && printf '%s\n' "$PROSER_REVISION" > /opt/proser/factory/REVISION \
    && if [ -n "$PROSER_VERSION" ]; then \
        printf '%s\n' "$PROSER_VERSION" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' \
        && printf '%s\n' "$PROSER_VERSION" > /opt/proser/factory/VERSION; \
    fi
USER node
WORKDIR /opt/proser/factory
CMD ["node", "dist/index.js"]
