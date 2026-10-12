#!/bin/sh
# Installs the Typst compiler and the Tinymist language server in the versions
# the worker image pins, verified against the same checksums. For machines that
# run the tests outside Docker: CI runners, and a developer's machine if wanted.
#
#   scripts/install-typst-tools.sh [directory]     (default: /usr/local/bin)
#
# The versions and checksums are read from apps/worker/Dockerfile, so there is
# one place to update them.
set -eu

target="${1:-/usr/local/bin}"
dockerfile="$(dirname "$0")/../apps/worker/Dockerfile"
pinned() { sed -n "s/^ARG $1=//p" "$dockerfile"; }

case "$(uname -m)" in
	x86_64) arch=x86_64; suffix=X86_64 ;;
	aarch64 | arm64) arch=aarch64; suffix=AARCH64 ;;
	*) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() {
	# fetch <url> <sha256> <file>
	curl -fsSL --retry 3 -o "$3" "$1"
	echo "$2  $3" | sha256sum -c - >/dev/null
}

typst_version="$(pinned TYPST_VERSION)"
name="typst-$arch-unknown-linux-musl"
fetch "https://github.com/typst/typst/releases/download/v$typst_version/$name.tar.xz" \
	"$(pinned "TYPST_SHA256_$suffix")" "$work/typst.tar.xz"
tar -xJf "$work/typst.tar.xz" -C "$work"
install -m 0755 "$work/$name/typst" "$target/typst"

tinymist_version="$(pinned TINYMIST_VERSION)"
name="tinymist-$arch-unknown-linux-musl"
fetch "https://github.com/Myriad-Dreamin/tinymist/releases/download/v$tinymist_version/$name.tar.gz" \
	"$(pinned "TINYMIST_SHA256_$suffix")" "$work/tinymist.tar.gz"
tar -xzf "$work/tinymist.tar.gz" -C "$work"
install -m 0755 "$work/$name/tinymist" "$target/tinymist"

echo "Installed Typst $typst_version and Tinymist $tinymist_version in $target"
