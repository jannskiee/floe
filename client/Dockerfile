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
FROM node:22-alpine AS builder

# Pin pnpm to package.json's `packageManager` version so `--frozen-lockfile`
# matches the lockfile exactly. pnpm 11.x requires Node 22+ (it uses the
# node:sqlite builtin), which is why the base image is node:22, not node:20.
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
# sitemap. Empty falls back to floe.one, so self-hosters should set it.
ARG NEXT_PUBLIC_SITE_URL=
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- Runner ----------------------------------------------------------------
FROM node:22-alpine AS runner

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# The standalone server reads HOSTNAME/PORT; bind all interfaces for Docker.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app

# Copy only the self-contained output produced by `output: 'standalone'`.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

USER node
EXPOSE 3000

CMD ["node", "server.js"]
