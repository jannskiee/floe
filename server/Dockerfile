# Floe signaling server — production image.
# The server only brokers WebRTC signaling and issues TURN credentials; it never
# touches file data. It binds 0.0.0.0:$PORT (default 3001) and reads its config
# from environment variables (see server/.env.example).

FROM node:20-alpine

# dumb-init reaps zombies and forwards SIGTERM/SIGINT so the server's graceful
# shutdown handlers fire cleanly on `docker stop`.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

# Install production dependencies first so this layer is cached across code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application files. words.json is required at runtime (require('./words.json')).
COPY server.js words.json ./

# Run as the unprivileged user that the node image already provides.
USER node

EXPOSE 3001

# Hit the built-in health endpoint. PORT is honored if overridden at runtime.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
