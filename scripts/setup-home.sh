#!/usr/bin/env bash
#
# Install + launch the cmux-home TUI (Ink/TypeScript port). This is the
# "headquarters" view: a Node-friendly dashboard for browsing cmux workspaces
# and starting Claude/Codex tasks. It connects to the running cmux app's
# local Unix socket, so it works against any cmux instance you launch
# locally — including one wired up to a self-hosted Next.js backend.
#
# Usage:
#   ./scripts/setup-home.sh [--checkout-dir ~/cmux-freestyle-home] [--ref main] [--no-clone]

set -euo pipefail

CHECKOUT_DIR=""
REF="main"
SKIP_CLONE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --checkout-dir) CHECKOUT_DIR="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --no-clone) SKIP_CLONE=1; shift ;;
    -h|--help)
      cat <<'USAGE'
Install + launch cmux-home (Ink TUI).

Options:
  --checkout-dir <path>  Default: ~/cmux-freestyle-home
  --ref <ref>            Default: main (use feat-ink-rewrite until the port is merged)
  --no-clone             Reuse an existing checkout at --checkout-dir
USAGE
      exit 0
      ;;
    *) echo "error: unknown option $1" >&2; exit 1 ;;
  esac
done

CHECKOUT_DIR="${CHECKOUT_DIR:-$HOME/cmux-freestyle-home}"

for tool in git bun; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool is required on PATH." >&2
    exit 1
  fi
done

if [ "$SKIP_CLONE" = 0 ]; then
  if [ -d "$CHECKOUT_DIR/.git" ]; then
    echo "[cmux-freestyle] updating cmux-home checkout at $CHECKOUT_DIR" >&2
    git -C "$CHECKOUT_DIR" fetch --quiet origin
    git -C "$CHECKOUT_DIR" checkout --quiet "$REF"
    git -C "$CHECKOUT_DIR" pull --quiet --ff-only origin "$REF" || true
  else
    echo "[cmux-freestyle] cloning manaflow-ai/cmux-home into $CHECKOUT_DIR (ref=$REF)" >&2
    git clone --quiet --branch "$REF" https://github.com/manaflow-ai/cmux-home.git "$CHECKOUT_DIR"
  fi
fi

INK_DIR="$CHECKOUT_DIR/ink"
if [ ! -d "$INK_DIR" ]; then
  cat >&2 <<EOF
error: $INK_DIR is missing. The Ink port lives on the 'feat-ink-rewrite' branch
       until it merges to main. Re-run with --ref feat-ink-rewrite.
EOF
  exit 1
fi

echo "[cmux-freestyle] installing cmux-home Ink deps" >&2
( cd "$INK_DIR" && bun install --silent )

cat <<EOF

cmux-home is ready at $INK_DIR
  run:   cd $INK_DIR && bun dev
  socket: \$CMUX_SOCKET_PATH (auto-discovered when launched from inside cmux)

The TUI lists every cmux workspace grouped by agent state, surfaces unread
notifications, and lets you spawn new Codex/Claude workspaces from the
composer at the bottom.
EOF
