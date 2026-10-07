# Compile worker: the official Typst CLI plus a small Node service.
# Build from the repository root:  docker build -f apps/worker/Dockerfile .

FROM debian:bookworm-slim AS typst
# Pinned Typst release. Update the version and both checksums together.
ARG TYPST_VERSION=0.15.1
ARG TYPST_SHA256_X86_64=a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c
ARG TYPST_SHA256_AARCH64=5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
	&& rm -rf /var/lib/apt/lists/*
RUN set -eu; \
	arch="$(uname -m)"; \
	case "$arch" in \
		x86_64) sha256="$TYPST_SHA256_X86_64" ;; \
		aarch64) sha256="$TYPST_SHA256_AARCH64" ;; \
		*) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
	esac; \
	name="typst-$arch-unknown-linux-musl"; \
	curl -fsSL -o /tmp/typst.tar.xz \
		"https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/${name}.tar.xz"; \
	echo "$sha256  /tmp/typst.tar.xz" | sha256sum -c -; \
	tar -xJf /tmp/typst.tar.xz -C /tmp; \
	install -m 0755 "/tmp/${name}/typst" /usr/local/bin/typst

FROM node:24-bookworm-slim
# Fonts available to every document, in addition to the ones Typst embeds
# (Libertinus Serif, New Computer Modern, DejaVu Sans Mono). Projects can bring
# their own font files; see docs/self-hosting.md for adding server-wide fonts.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		fontconfig fonts-liberation2 fonts-dejavu fonts-noto-core \
	&& rm -rf /var/lib/apt/lists/* \
	&& fc-cache -f
COPY --from=typst /usr/local/bin/typst /usr/local/bin/typst

WORKDIR /app
COPY apps/worker/package.json ./
COPY apps/worker/src ./src

# Inside this image the container is the sandbox: run it read-only, without
# capabilities and on a network with no route out (see deploy/compose.yaml).
# bubblewrap cannot create namespaces under Docker's default seccomp profile.
ENV NODE_ENV=production \
	KERNIC_WORKER_HOST=0.0.0.0 \
	KERNIC_WORKER_PORT=3101 \
	KERNIC_WORKER_SANDBOX=none \
	KERNIC_WORKER_DIR=/work

USER node
EXPOSE 3101
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
	CMD node -e "fetch('http://127.0.0.1:3101/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.ts"]
