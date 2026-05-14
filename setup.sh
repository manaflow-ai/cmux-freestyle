#!/usr/bin/env bash
#
# cmux-freestyle: build a Freestyle VM snapshot that matches the cmux Cloud VM
# image. Designed to be invoked from a clone of manaflow-ai/cmux-freestyle.
#
# Required env:
#   FREESTYLE_API_KEY   Freestyle API key, https://dash.freestyle.sh
#
# Optional env / flags: see README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f .env ] && [ -z "${CMUX_FREESTYLE_SKIP_DOTENV:-}" ]; then
  # shellcheck disable=SC1091
  set -a
  . ./.env
  set +a
fi

PEEK_SUB="snapshot"
if [ $# -gt 0 ]; then
  case "$1" in
    snapshot|home|web|doctor|skills|vm) PEEK_SUB="$1" ;;
  esac
fi

if [ "$PEEK_SUB" = "snapshot" ] || [ "$PEEK_SUB" = "web" ] || [ "$PEEK_SUB" = "vm" ]; then
  if [ -z "${FREESTYLE_API_KEY:-}" ]; then
    echo "error: FREESTYLE_API_KEY is required for '$PEEK_SUB'." >&2
    echo "  Get one from https://dash.freestyle.sh and either:" >&2
    echo "    export FREESTYLE_API_KEY=fk_..." >&2
    echo "    cp .env.example .env && edit .env" >&2
    exit 1
  fi
fi

RUNNER=""
if [ "$PEEK_SUB" = "snapshot" ] || [ "$PEEK_SUB" = "vm" ]; then
  if command -v bun >/dev/null 2>&1; then
    RUNNER="bun"
  elif command -v node >/dev/null 2>&1; then
    RUNNER="node"
  else
    echo "error: need either bun or node 20+ on PATH for 'snapshot'." >&2
    echo "  Install bun:  curl -fsSL https://bun.sh/install | bash" >&2
    echo "  Install node: https://nodejs.org or your platform's package manager" >&2
    exit 1
  fi

  if [ "$RUNNER" = "node" ]; then
    NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
    if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
      echo "error: node $NODE_MAJOR is too old. cmux-freestyle requires node 20+ or bun." >&2
      exit 1
    fi
  fi

  if [ ! -d node_modules ]; then
    echo "[cmux-freestyle] installing JS deps with $RUNNER" >&2
    if [ "$RUNNER" = "bun" ]; then
      bun install --silent
    else
      if command -v npm >/dev/null 2>&1; then
        npm install --silent --no-audit --no-fund
      else
        echo "error: npm not found alongside node." >&2
        exit 1
      fi
    fi
  fi
fi

SUBCOMMAND="snapshot"
if [ $# -gt 0 ]; then
  case "$1" in
    snapshot|home|web|doctor|skills|vm) SUBCOMMAND="$1"; shift ;;
  esac
fi

case "$SUBCOMMAND" in
  snapshot)
    if [ "$RUNNER" = "bun" ]; then
      exec bun run scripts/build-snapshot.ts "$@"
    else
      exec npx --no-install tsx scripts/build-snapshot.ts "$@"
    fi
    ;;
  vm)
    if [ "$RUNNER" = "bun" ]; then
      exec bun run scripts/vm.ts "$@"
    else
      exec npx --no-install tsx scripts/vm.ts "$@"
    fi
    ;;
  home)
    exec "$SCRIPT_DIR/scripts/setup-home.sh" "$@"
    ;;
  web)
    exec "$SCRIPT_DIR/scripts/setup-web-dev.sh" "$@"
    ;;
  doctor)
    exec "$SCRIPT_DIR/scripts/doctor.sh" "$@"
    ;;
  skills)
    exec "$SCRIPT_DIR/skills.sh" "$@"
    ;;
  *)
    echo "unknown subcommand: $SUBCOMMAND" >&2
    exit 1
    ;;
esac
