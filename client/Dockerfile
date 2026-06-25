# Floe web client — multi-stage production image.
#
# IMPORTANT: NEXT_PUBLIC_SOCKET_URL is inlined into the bundle at BUILD time by
# Next.js, not read at runtime. Pass it as a build arg pointing at your signaling
# server's externally reachable URL. Changing it later requires rebuilding this
# image (`docker compose build client`).

# ---- Builder ---------------------------------------------------------------
FROM node:20-alpine AS builder

RUN npm install -g pnpm@11
WORKDIR /app

# Install dependencies first for layer caching.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build the standalone server. Sentry source-map upload stays disabled unless you
# also provide SENTRY_* build args, so the build works with no extra config.
COPY . .
ARG NEXT_PUBLIC_SOCKET_URL=http://localhost:3001
ENV NEXT_PUBLIC_SOCKET_URL=${NEXT_PUBLIC_SOCKET_URL}
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- Runner ----------------------------------------------------------------
FROM node:20-alpine AS runner

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
