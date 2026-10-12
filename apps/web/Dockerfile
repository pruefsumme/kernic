# Web app: SvelteKit built for Node.
# Build from the repository root:  docker build -f apps/web/Dockerfile .

FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo

# Install dependencies first, so this layer is reused while only sources change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
RUN pnpm --filter @kernic/web build
# What this image is, for the scripts around it (backup, restore, upgrade): its version and
# the database migrations it carries. They can read this without starting the app.
RUN mkdir /release \
	&& node -p "require('./apps/web/package.json').version" > /release/version.txt \
	&& ls apps/web/src/lib/server/db/migrations | sed -n 's/\.sql$//p' | LC_ALL=C sort > /release/migrations.txt
# Production dependencies only (the build bundles everything else).
RUN pnpm --filter @kernic/web deploy --legacy --prod /out

FROM node:24-bookworm-slim
# Git records the version history (checkpoints) of each project. The certificate
# authorities are for Git itself: it pushes checkpoints to forges over HTTPS and
# does not use the ones built into Node.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/web/build ./build
COPY --from=build /release ./release
RUN mkdir /data && chown node:node /data

# The app is meant to sit behind the reverse proxy from deploy/compose.yaml,
# which tells it the public protocol, host and client address. BODY_SIZE_LIMIT
# must stay above the largest allowed project archive (KERNIC_MAX_PROJECT_MB).
# Idle connections are kept open longer than the proxy keeps its side (2 minutes),
# so the proxy never sends a request on a connection the app is just closing.
ENV NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=3000 \
	BODY_SIZE_LIMIT=256M \
	KEEP_ALIVE_TIMEOUT=130 \
	HEADERS_TIMEOUT=135 \
	PROTOCOL_HEADER=x-forwarded-proto \
	HOST_HEADER=x-forwarded-host \
	ADDRESS_HEADER=x-forwarded-for \
	XFF_DEPTH=1 \
	KERNIC_DATA_DIR=/data

USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
	CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "build"]
