# Compile worker: the official Typst CLI, the Tinymist language server, and a
# small Node service.
# Build from the repository root:  docker build -f apps/worker/Dockerfile .

FROM debian:trixie-slim AS typst
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

# Pinned Tinymist release, for editor assistance. Its releases follow Typst's:
# pick the one built for the Typst version above, and update the version and
# both checksums together.
ARG TINYMIST_VERSION=0.15.8
ARG TINYMIST_SHA256_X86_64=816d33895ae343f934403dbd73f687a531368464450451510f3c108b0c04bcfd
ARG TINYMIST_SHA256_AARCH64=8055377bfd463c05dc7e9cf4116d355ba0c2bb80a68a583b31905830f2d311eb
RUN set -eu; \
	arch="$(uname -m)"; \
	case "$arch" in \
		x86_64) sha256="$TINYMIST_SHA256_X86_64" ;; \
		aarch64) sha256="$TINYMIST_SHA256_AARCH64" ;; \
		*) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
	esac; \
	name="tinymist-$arch-unknown-linux-musl"; \
	curl -fsSL -o /tmp/tinymist.tar.gz \
		"https://github.com/Myriad-Dreamin/tinymist/releases/download/v${TINYMIST_VERSION}/${name}.tar.gz"; \
	echo "$sha256  /tmp/tinymist.tar.gz" | sha256sum -c -; \
	tar -xzf /tmp/tinymist.tar.gz -C /tmp; \
	install -m 0755 "/tmp/${name}/tinymist" /usr/local/bin/tinymist

# Debian 13: its util-linux (2.41) provides `setpriv` with Landlock support, which
# confines each compile to its own files.
FROM node:24-trixie-slim
# Fonts available to every document, in addition to the ones Typst embeds
# (Libertinus Serif, New Computer Modern, DejaVu Sans Mono). Distribution
# packages only, so each font has a clear licence and update path. Projects can
# bring their own font files; see docs/self-hosting.md for adding server-wide fonts.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		fontconfig \
		fonts-liberation2 fonts-dejavu fonts-noto-core \
		fonts-inter fonts-roboto fonts-open-sans fonts-lato \
		fonts-texgyre fonts-lmodern fonts-cmu fonts-stix \
		fonts-linuxlibertine fonts-ebgaramond fonts-atkinson-hyperlegible \
		fonts-firacode fonts-jetbrains-mono \
	&& rm -rf /var/lib/apt/lists/* \
	&& fc-cache -f
COPY --from=typst /usr/local/bin/typst /usr/local/bin/tinymist /usr/local/bin/

WORKDIR /app
COPY apps/worker/package.json ./
COPY apps/worker/src ./src

# Two layers of confinement. The container: read-only, without capabilities, on a
# network with no route out (see deploy/compose.yaml). And inside it, Landlock:
# each compile can only open its own job, never another project's files in the
# worker's cache. (bubblewrap cannot create namespaces under Docker's default
# seccomp profile; Landlock needs no privileges.)
ENV NODE_ENV=production \
	KERNIC_WORKER_HOST=0.0.0.0 \
	KERNIC_WORKER_PORT=3101 \
	KERNIC_WORKER_SANDBOX=landlock \
	KERNIC_WORKER_DIR=/work

USER node
EXPOSE 3101
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
	CMD node -e "fetch('http://127.0.0.1:3101/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.ts"]
