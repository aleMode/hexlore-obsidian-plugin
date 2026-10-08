#!/bin/sh
# Copy the contract from the Flutter repository into vendor/.
#
# The Flutter repo is the source of truth for the format, the conformance
# fixtures, the shared render spec and the variant ids. This plugin keeps a
# plain copy of each, and vendor/SOURCE records the Flutter commit it came
# from. Never edit vendor/ by hand: change Flutter, then re-run this.
#
# Usage: scripts/vendor-from-flutter.sh [path-to-flutter-repo]
#        (default: $HEXLORE_FLUTTER, else the repository this folder sits in
#        while the plugin lives in obsidian-plugin/, else ../software_hexlore)
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
if [ -d "$here/../hexlore_flutter" ]; then
	default="$here/.."
else
	default="$here/../software_hexlore"
fi
src=${1:-${HEXLORE_FLUTTER:-$default}}
src=$(cd "$src" && pwd)
app="$src/hexlore_flutter"

[ -f "$app/pubspec.yaml" ] || { echo "not a HexLore Flutter repo: $src" >&2; exit 1; }

paths="hexlore_flutter/test/fixtures/conformance docs/format-2.md \
hexlore_flutter/assets/player hexlore_flutter/tool/variant_ids.lock"

# Vendoring uncommitted files would record a commit they are not in.
# shellcheck disable=SC2086
if [ -n "$(git -C "$src" status --porcelain -- $paths)" ]; then
	echo "warning: the Flutter repo has uncommitted changes in the vendored paths;" >&2
	echo "         vendor/SOURCE will say so." >&2
	dirty=" (dirty)"
else
	dirty=""
fi

out="$here/vendor"
rm -rf "$out"
mkdir -p "$out/conformance" "$out/docs" "$out/player"

cp "$app"/test/fixtures/conformance/*.json "$app"/test/fixtures/conformance/README.md "$out/conformance/"
cp "$src/docs/format-2.md" "$out/docs/"
cp "$app"/assets/player/* "$out/player/"
cp "$app/tool/variant_ids.lock" "$out/"

{
	echo "$(git -C "$src" rev-parse HEAD)$dirty"
	git -C "$src" log -1 --format='%cI %s'
} > "$out/SOURCE"

echo "vendored from $(head -1 "$out/SOURCE")"
