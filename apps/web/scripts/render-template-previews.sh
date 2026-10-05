#!/bin/sh
# Renders the first page of every built-in template to static/template-previews/.
# Run after changing a template: pnpm --filter @kernic/web templates:previews
set -eu

cd "$(dirname "$0")/.."
templates=src/lib/server/projects/templates
out=static/template-previews
mkdir -p "$out"

for dir in "$templates"/*/; do
	id=$(basename "$dir")
	typst compile --root "$dir" --format svg --pages 1 "$dir/main.typ" "$out/$id.svg"
	echo "rendered $out/$id.svg"
done
