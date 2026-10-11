# Keyvoria API. Small on purpose: the only runtime dependency is `pg`.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Copy manifests first so a code change does not reinstall dependencies.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Run as a non-root user: a process that never needs to write to disk should not
# be able to.
USER node

EXPOSE 8787
# Hosts send SIGTERM. Node must receive it directly to drain in-flight requests,
# which is why there is no shell wrapper here.
CMD ["node", "src/http/server.js"]
