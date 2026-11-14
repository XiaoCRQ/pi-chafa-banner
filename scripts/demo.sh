#!/usr/bin/env bash
# User-facing smoke test for pi-chafa-banner.
#
#   bash scripts/demo.sh                 # animate with defaults
#   bash scripts/demo.sh --static        # one frame, no timer
#   bash scripts/demo.sh --fps 12        # slower animation
#   bash scripts/demo.sh --size 60x30    # bigger chafa canvas
#   bash scripts/demo.sh --gif ~/Pictures/logo/v-1.gif   # override the bundled art
#
# Everything is passed to pi through PI_BANNER_* environment variables, so the
# extension needs no settings file. This script only starts an interactive pi;
# Ctrl-C / /exit ends it as usual.
set -euo pipefail

usage() {
	cat <<'EOF'
usage: bash scripts/demo.sh [--static] [--fps N] [--size WxH] [--gif PATH]

  --static      render one frame (PI_BANNER_STATIC=1), no animation timer
  --fps N       frames per second, 1-30 (PI_BANNER_FPS)
  --size WxH    chafa canvas, e.g. 44x22 (PI_BANNER_SIZE)
  --gif PATH    gif to animate (PI_BANNER_GIF)
  -h, --help    this text
EOF
}

STATIC=0
FPS=""
SIZE=""
GIF=""
ORIGINAL_ARGS=("$@")

while [ $# -gt 0 ]; do
	case "$1" in
		--static)
			STATIC=1
			shift
			;;
		--fps)
			[ $# -ge 2 ] || { echo "demo: --fps needs a value" >&2; exit 2; }
			FPS="$2"
			shift 2
			;;
		--fps=*)
			FPS="${1#*=}"
			shift
			;;
		--size)
			[ $# -ge 2 ] || { echo "demo: --size needs a value (WxH)" >&2; exit 2; }
			SIZE="$2"
			shift 2
			;;
		--size=*)
			SIZE="${1#*=}"
			shift
			;;
		--gif)
			[ $# -ge 2 ] || { echo "demo: --gif needs a path" >&2; exit 2; }
			GIF="$2"
			shift 2
			;;
		--gif=*)
			GIF="${1#*=}"
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			echo "demo: unknown argument '$1'" >&2
			usage >&2
			exit 2
			;;
	esac
done

# Always run from the repository root, whichever directory the user called us from.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v pi >/dev/null 2>&1; then
	echo "demo: 'pi' is not on PATH. Install it first (npm i -g @earendil-works/pi-coding-agent)." >&2
	exit 127
fi

if [ "$STATIC" = "1" ]; then
	export PI_BANNER_STATIC=1
fi

if [ -n "$FPS" ]; then
	case "$FPS" in
		''|*[!0-9]*) echo "demo: --fps must be an integer, got '$FPS'" >&2; exit 2 ;;
	esac
	if [ "$FPS" -lt 1 ] || [ "$FPS" -gt 30 ]; then
		echo "demo: --fps must be between 1 and 30, got '$FPS'" >&2
		exit 2
	fi
	export PI_BANNER_FPS="$FPS"
fi

if [ -n "$SIZE" ]; then
	if ! printf '%s' "$SIZE" | grep -Eq '^[0-9]+[xX*][0-9]+$'; then
		echo "demo: --size must look like WxH (e.g. 44x22), got '$SIZE'" >&2
		exit 2
	fi
	export PI_BANNER_SIZE="$SIZE"
fi

if [ -n "$GIF" ]; then
	if [ ! -f "$GIF" ]; then
		echo "demo: gif not found: $GIF" >&2
		exit 2
	fi
	# Make the path absolute before pi changes its working directory.
	export PI_BANNER_GIF="$(cd "$(dirname "$GIF")" && pwd)/$(basename "$GIF")"
fi

# Show exactly what pi will see, so a wrong flag is obvious before the TUI starts.
echo "pi-chafa-banner demo"
echo "  repo:  $REPO_ROOT"
echo "  flags: ${ORIGINAL_ARGS[*]:-<none>}"
echo "  env:   PI_BANNER_STATIC=${PI_BANNER_STATIC:-0} PI_BANNER_FPS=${PI_BANNER_FPS:-16} PI_BANNER_SIZE=${PI_BANNER_SIZE:-44x22} PI_BANNER_GIF=${PI_BANNER_GIF:-<auto: bundled assets/banner.gif>}"
echo "  start: pi -e ."
echo

exec pi -e .
