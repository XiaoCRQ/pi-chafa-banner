#!/usr/bin/env bash
# Smoke test for pi-chafa-banner.
#
#   bash scripts/demo.sh                 # start pi with the extension loaded
#   bash scripts/demo.sh --preview       # same layout, no TUI (fastest loop)
#   bash scripts/demo.sh --preview --size 60x30
#
# Configuration lives in `pi-chafa-banner.json` next to this package (see
# README.md); this script never sets environment variables and never writes the
# file. `--preview` forwards every argument to scripts/preview.ts.
set -euo pipefail

usage() {
	cat <<'EOF'
usage: bash scripts/demo.sh [--preview [preview flags]] [--help]

  --preview     render the splash with scripts/preview.ts instead of starting pi
  -h, --help    this text

Real runs read <repo>/pi-chafa-banner.json; copy
pi-chafa-banner.example.json to that name and edit it.
EOF
}

MODE="pi"
ARGS=()
while [ $# -gt 0 ]; do
	case "$1" in
		--preview) MODE="preview" ;;
		-h|--help) usage; exit 0 ;;
		*) ARGS+=("$1") ;;
	esac
	shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CONFIG="$REPO_ROOT/pi-chafa-banner.json"

if [ "$MODE" = "preview" ]; then
	export PI_IMAGE_PROTOCOL="${PI_IMAGE_PROTOCOL:-}"
	exec bun run scripts/preview.ts ${ARGS[@]+"${ARGS[@]}"}
fi

if ! command -v pi >/dev/null 2>&1; then
	echo "demo: 'pi' is not on PATH. Install it first (npm i -g @earendil-works/pi-coding-agent)." >&2
	exit 127
fi

echo "pi-chafa-banner demo"
echo "  repo:   $REPO_ROOT"
if [ -f "$CONFIG" ]; then
	echo "  config: $CONFIG"
else
	echo "  config: built-in defaults (no pi-chafa-banner.json; copy the example to change it)"
fi
echo "  start:  pi -e ."
echo
exec pi -e .
