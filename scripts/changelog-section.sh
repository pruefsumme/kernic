#!/bin/sh
# Prints what CHANGELOG.md says about one version: the text under its "## <version>" heading,
# up to the next heading.
#
#   scripts/changelog-section.sh <version> [--upgrade-notes] [CHANGELOG.md]
#
# --upgrade-notes prints only what is under "**Upgrade notes**". Exits with an error and prints
# nothing if the version has no section (or, with --upgrade-notes, no such notes).
set -eu

version="${1:-}"
[ -n "$version" ] || {
	echo "usage: scripts/changelog-section.sh <version> [--upgrade-notes] [CHANGELOG.md]" >&2
	exit 2
}
shift
only_notes=0
if [ "${1:-}" = --upgrade-notes ]; then
	only_notes=1
	shift
fi
file="${1:-$(dirname "$0")/../CHANGELOG.md}"

text="$(awk -v version="$version" -v only_notes="$only_notes" '
	/^## / {
		if (inside) exit
		inside = ($2 == version)
		next
	}
	inside {
		if (only_notes) {
			if ($0 == "**Upgrade notes**") { notes = 1; next }
			if (notes && /^\*\*/) { notes = 0 }
			if (notes) print
		} else {
			print
		}
	}
' "$file")"

# Blank lines at either end do not count.
text="$(printf '%s\n' "$text" | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}')"
[ -n "$text" ] || exit 1
printf '%s\n' "$text"
