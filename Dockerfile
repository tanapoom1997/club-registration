# Production images (docs/operations.md "Infra และ Deployment"). Build from the repo root:
#
#   docker build --target api -t club-registration-api .
#   docker build --target web -t club-registration-web .
#
# One file with two targets rather than one Dockerfile per app: both images start from the same
# pnpm install, so BuildKit runs it once and caches it for both, and the base images are pinned in
# one place. Only the stages a target needs are built.
#
# Needs BuildKit (the default builder since Docker Engine 23) for the cache and secret mounts.

# Tag for people, digest for the build: a tag can be moved to other contents, a digest cannot.
# Both digests are multi-arch indexes, so the arm64 EC2 host (t4g) and amd64 CI resolve the same
# pin to their own platform. Bump tag and digest together.
ARG NODE_IMAGE=node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ARG CADDY_IMAGE=caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0

# Network steps below mount an optional build secret "extra_ca" (a PEM bundle) and trust it, for
# building behind a TLS-intercepting proxy: docker build --secret id=extra_ca,src=<file> ...
# A secret mount is never written to a layer, so the certificate does not ship in the image.

FROM ${NODE_IMAGE} AS pnpm
# Corepack would otherwise stop and ask before downloading the pinned pnpm.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
RUN corepack enable
# The lockfile alone decides what pnpm fetch downloads, so editing a package.json script or any
# source file does not throw away the download layer.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
# corepack install reads packageManager from package.json: the same pnpm as on a developer machine.
RUN --mount=type=secret,id=extra_ca \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    corepack install
RUN --mount=type=cache,id=club-registration-pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=extra_ca \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm fetch --store-dir /pnpm/store

FROM pnpm AS deps
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=club-registration-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --store-dir /pnpm/store
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/

FROM deps AS build-api
COPY apps/api/ apps/api/
# api... = api and the workspace packages it depends on, built in dependency order (shared first).
RUN pnpm --filter "api..." build
# A standalone copy of the api with production dependencies only. The built shared package is
# copied in as a real directory, so the runtime image needs no workspace around it.
RUN --mount=type=cache,id=club-registration-pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=extra_ca \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm --filter api deploy --prod --store-dir /pnpm/store /deploy
# Development-only entry points stay out of the image. seed-dev creates demo accounts whose
# passwords it writes to a file (it already refuses NODE_ENV=production; absent is stronger), and
# generate-template rewrites templates/ in a checkout. dev/ is imported by seed-dev alone. rm
# without -f fails the build if one is renamed, so this list cannot silently go stale.
RUN rm -r /deploy/dist/seed-dev.js /deploy/dist/generate-template.js /deploy/dist/dev

FROM deps AS build-web
COPY apps/web/ apps/web/
RUN pnpm --filter web build

# --- api: Fastify on Node. Migrations and admin creation run as one-off commands in this image:
#   docker run --rm ... club-registration-api node dist/migrate.js
#   docker run --rm -it ... club-registration-api node dist/create-admin.js <login_id>
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production
# The repo's layout, not a flat /app: dist/import/template.js finds templates/ four directories up
# from itself, exactly as it does in a checkout, so the template download needs no special path.
WORKDIR /app/apps/api
COPY templates/import-template.xlsx /app/templates/
# Least-changing first. Everything stays owned by root: the app runs as "node" and cannot rewrite
# its own code or dependencies.
COPY --from=build-api /deploy/node_modules ./node_modules
COPY --from=build-api /deploy/package.json ./
COPY --from=build-api /deploy/migrations ./migrations
# The PDF export reads the fonts at boot from ../../assets/fonts relative to dist/export, so the
# server does not start without them (OFL.txt must travel with the fonts).
COPY --from=build-api /deploy/assets ./assets
COPY --from=build-api /deploy/dist ./dist
USER node
EXPOSE 3000
# The slim image has no curl, so node itself asks /api/health (503 when the database is down).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
    CMD ["node", "--input-type=module", "-e", "const res = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/api/health`, { signal: AbortSignal.timeout(4000) }).catch(() => null); process.exit(res?.ok ? 0 : 1);"]
# Exec form: node is PID 1 (the base entrypoint execs it) and receives docker stop's SIGTERM
# itself, so server.ts closes Fastify and the pool before exiting.
CMD ["node", "dist/server.js"]

# --- web: Caddy serving the built SPA and proxying /api/* to the api container (Caddyfile).
FROM ${CADDY_IMAGE} AS web
# The official image runs Caddy as root. A plain user is enough: Docker lets containers bind ports
# below 1024 without root (net.ipv4.ip_unprivileged_port_start=0), and Caddy only writes under
# /data (certificates) and /config (autosave), which this user owns.
RUN addgroup -S -g 1000 caddy \
    && adduser -S -D -H -u 1000 -G caddy -s /sbin/nologin caddy \
    && chown -R caddy:caddy /data /config
COPY Caddyfile /etc/caddy/Caddyfile
# Fails the build on a Caddyfile error instead of at container start. Validating provisions the
# config's apps, which can create a local CA (key included) under XDG_DATA_HOME; a throwaway
# directory keeps that out of /data, so no image ships key material and the certificate volume
# starts empty and owned by caddy.
RUN XDG_DATA_HOME=/tmp/caddy-validate XDG_CONFIG_HOME=/tmp/caddy-validate \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
    && rm -rf /tmp/caddy-validate
COPY --from=build-web /repo/apps/web/dist /srv
USER caddy
