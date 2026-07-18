# Floe web client — multi-stage production image.
#
# Source builds can still bake NEXT_PUBLIC_SOCKET_URL into the bundle. Published
# images instead read FLOE_SOCKET_URL/FLOE_SOCKET_PORT at container startup, so
# one image can run on different Docker and Unraid hosts without rebuilding.

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
ARG NEXT_PUBLIC_SOCKET_URL=
ENV NEXT_PUBLIC_SOCKET_URL=${NEXT_PUBLIC_SOCKET_URL}
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
COPY --chown=node:node --from=builder /app/public ./public
COPY --chown=node:node --from=builder /app/.next/standalone ./
COPY --chown=node:node --from=builder /app/.next/static ./.next/static
COPY --chown=node:node write-runtime-config.mjs docker-entrypoint.sh ./

RUN chmod +x /app/docker-entrypoint.sh

USER node
EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
