# Floe web client, multi-stage production image.
#
# The signaling server address is resolved at RUNTIME. Set SOCKET_URL on the
# running container and the browser picks it up from /api/config on next load, so
# changing it needs only `docker compose up -d`, no rebuild. Leave SOCKET_URL
# empty when the client and the signaling server share one origin behind a
# reverse proxy; the browser then uses its own origin.
#
# NEXT_PUBLIC_SOCKET_URL still exists as a build arg and still wins when set, but
# Next inlines it into the bundle, so a value baked here can never be changed
# without rebuilding. It defaults to empty for exactly that reason.

# ---- Builder ---------------------------------------------------------------
FROM node:24-alpine AS builder

# Pin pnpm to package.json's `packageManager` version so `--frozen-lockfile`
# matches the lockfile exactly. pnpm 11.x needs Node 22+ (it uses the node:sqlite
# builtin), which the Active LTS satisfies. Track LTS rather than Current here:
# this image is run unattended by self-hosters, so a runtime with a long support
# window matters more than a new one.
RUN npm install -g pnpm@11.1.2
WORKDIR /app

# Install dependencies first for layer caching. pnpm-workspace.yaml carries the
# dependency `overrides` (security pins) baked into the lockfile; without it,
# `--frozen-lockfile` aborts with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Build the standalone server. Sentry source-map upload stays disabled unless you
# also provide SENTRY_* build args, so the build works with no extra config.
COPY . .
# Empty on purpose: an inlined URL cannot be changed at runtime, and a prebuilt
# image can only ever bake one. Set it only if you deliberately want a fixed URL
# compiled into this image.
ARG NEXT_PUBLIC_SOCKET_URL=
ENV NEXT_PUBLIC_SOCKET_URL=${NEXT_PUBLIC_SOCKET_URL}
# Public origin of this client, used for canonical links, Open Graph tags, and the
# sitemap. Unlike the signaling URL this CANNOT be resolved at runtime, because
# Next bakes metadata into the prerendered HTML at build time. Set it only if you
# are building this image yourself and want your own domain in share previews;
# the image published to ghcr.io leaves it empty by necessity.
ARG NEXT_PUBLIC_SITE_URL=
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}
# Marks this build as an image we hand to strangers. lib/siteUrl.ts reads it and,
# when no explicit site URL was given, emits NO absolute URL anywhere rather than
# falling back to floe.one, which every self-hosted instance would otherwise
# claim as its canonical, share-preview host, and sitemap host.
#
# It is a build flag rather than a plain removal of that fallback so the change is
# a provable no-op for every other build, including the canonical floe.one deploy.
ENV FLOE_DISTRIBUTABLE_IMAGE=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- Runner ----------------------------------------------------------------
FROM node:24-alpine AS runner

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Repeated from the builder stage on purpose. Every metadata route is statically
# prerendered today, so the build-time value is already baked into the output and
# this is redundant. It stops being redundant the moment any of them turns
# dynamic: FLOE_DISTRIBUTABLE_IMAGE is not a NEXT_PUBLIC_ variable, so Next does
# not inline it, and a route rendered at request time would read it from the
# running container and fall back to floe.one. One line to make that impossible.
ENV FLOE_DISTRIBUTABLE_IMAGE=1
# The standalone server reads HOSTNAME/PORT; bind all interfaces for Docker.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app

# Copy only the self-contained output produced by `output: 'standalone'`.
#
# --chown matters, it is not tidiness. COPY writes as root by default, so
# /app/.next ends up root-owned while the server runs as `node` below. Next then
# cannot create /app/.next/cache, and every /_next/image request fails to write
# its cache entry: the response is still a correct WebP, so nothing looks broken,
# but the image is re-encoded on every single request and an unhandled rejection
# is logged each time. Silent CPU burn plus log noise for every self-hoster.
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000

CMD ["node", "server.js"]
