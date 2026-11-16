# Desk Pet relay. Multi-stage; the server process runs as the unprivileged `node` user.
# No runtime npm dependencies: Node 24 runs the TypeScript sources directly (type stripping),
# persistence is node:sqlite.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY test ./test
# Type-check and run the test suite at build time; the runtime stage copies only src/.
RUN npm test

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DESKPET_DB=/data/deskpet.sqlite
WORKDIR /app
COPY --from=build --chown=root:root /app/package.json ./package.json
COPY --from=build --chown=root:root /app/src ./src
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# /data is the SQLite volume. Owned by the app user; the entrypoint re-asserts this because
# Fly mounts a fresh volume root-owned, then drops privileges to `node` (setpriv) before
# starting the server.
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/main.ts"]
