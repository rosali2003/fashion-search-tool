# syntax=docker/dockerfile:1.7
#
# Build context is the REPO ROOT, not backend/. pnpm needs the root manifest,
# pnpm-workspace.yaml, the lockfile and every workspace package.json to resolve a
# --frozen-lockfile install. On Railway that means the service's Root Directory
# stays empty and Dockerfile Path is `backend/Dockerfile`.

##############################################################################
# base — pnpm on Node 22, manifests only.
##############################################################################
FROM node:22-alpine AS base

# Alpine over slim: nothing in the backend's runtime tree is a native addon (pg
# is pure JS and pg-native is not installed; kysely, hono, openai and the
# Anthropic SDK are all pure JS), and there is no Intl/toLocaleString use in
# backend/src. That removes the musl risk and buys a ~60MB base instead of
# ~220MB — which on a hosting platform is pull time on every deploy and rollback.
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    CI=true

RUN corepack enable

WORKDIR /app

# Manifests only. This layer is invalidated by a dependency change, never by a
# source edit, so the installs below stay cached across ordinary commits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json  backend/package.json
COPY frontend/package.json frontend/package.json
COPY scrapers/package.json scrapers/package.json

##############################################################################
# prod-deps — the runtime tree and nothing else.
##############################################################################
FROM base AS prod-deps

# `--filter backend` selects only that project; the root workspace project is not
# included unless matched explicitly, so the root-level tsx devDependency and its
# esbuild binary never reach this stage. `--prod` then drops backend's own
# devDependencies (typescript, tsx, @types/*).
# No BuildKit cache mount here. Railway's Metal builder rejects a cache mount
# whose id lacks its own cacheKey prefix ("dockerfile invalid: flag
# '--mount=type=cache,id=pnpm-store,...' is missing the cacheKey prefix from its
# id"), and a store that only speeds up rebuilds is not worth a platform-specific
# id scheme in a Dockerfile that also has to build locally.
RUN pnpm install --frozen-lockfile --prod --filter backend

##############################################################################
# build — full backend tree, then tsc.
##############################################################################
FROM base AS build

RUN pnpm install --frozen-lockfile --filter backend

COPY backend/tsconfig.json backend/tsconfig.build.json backend/
COPY backend/src backend/src

RUN pnpm --filter backend run build

##############################################################################
# runtime
##############################################################################
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000

# Node as PID 1 does not terminate on SIGTERM: the kernel delivers no default
# action to PID 1, and Node installs no handler. Without an init the container
# ignores the platform's stop signal and waits out the SIGKILL grace period on
# every single deploy. tini is ~200KB and fixes it.
RUN apk add --no-cache tini

WORKDIR /app

# The whole /app tree, not just node_modules: pnpm's layout is a forest of
# RELATIVE symlinks into /app/node_modules/.pnpm, so /app/node_modules and
# /app/backend/node_modules have to arrive together and at the same relative
# depth. This also carries backend/package.json, which is load-bearing — its
# "type": "module" is what makes Node read dist/*.js as ESM rather than CJS.
COPY --from=prod-deps --chown=node:node /app /app
COPY --from=build     --chown=node:node /app/backend/dist /app/backend/dist

# uid 1000, ships with the image. The process writes nothing to disk.
USER node

# Keeping backend/ one level below /app is what makes the `../../..` REPO_ROOT
# in dist/db/index.js and dist/ingest/load.js resolve to /app. Flattening the
# package to /app would silently make REPO_ROOT "/" and OUTPUT_ROOT "/output".
WORKDIR /app/backend

EXPOSE 3000

# No HEALTHCHECK instruction: Railway ignores it in favour of healthcheckPath,
# and two sources of truth is worse than one.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
