#!/usr/bin/env bash
#
# Bootstrap a local cmux Next.js dev environment that points at the Freestyle
# snapshot built by ./setup.sh.
#
# Usage:
#   ./scripts/setup-web-dev.sh \
#     --snapshot sh-xxxxxxxxxxxxxxxxxxxx \
#     [--checkout-dir ~/cmux] \
#     [--cmux-ref main] \
#     [--no-install] [--no-postgres] [--no-clone]
#
# Required env: FREESTYLE_API_KEY (the same account that owns --snapshot).
# Optional env: STACK_SECRET_SERVER_KEY, NEXT_PUBLIC_STACK_PROJECT_ID,
#   NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY — needed if you want sign-in;
#   the script will still write a usable .env without them.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CHECKOUT_DIR=""
CMUX_REF="main"
SNAPSHOT=""
SKIP_INSTALL=0
SKIP_POSTGRES=0
SKIP_CLONE=0

usage() {
  cat <<'USAGE'
cmux-freestyle: bootstrap a local cmux Next.js dev env.

Required:
  --snapshot <id>        Freestyle snapshot id from ./setup.sh.

Optional:
  --checkout-dir <path>  Where to clone manaflow-ai/cmux. Default: ~/cmux-freestyle-cmux.
  --cmux-ref <ref>       Branch/tag of cmux to check out. Default: main.
  --no-clone             Reuse an existing checkout at --checkout-dir.
  --no-install           Skip "bun install" in web/.
  --no-postgres          Skip the docker-compose Postgres bring-up.
  -h, --help             Show this help.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --snapshot) SNAPSHOT="${2:-}"; shift 2 ;;
    --checkout-dir) CHECKOUT_DIR="${2:-}"; shift 2 ;;
    --cmux-ref) CMUX_REF="${2:-}"; shift 2 ;;
    --no-clone) SKIP_CLONE=1; shift ;;
    --no-install) SKIP_INSTALL=1; shift ;;
    --no-postgres) SKIP_POSTGRES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option $1" >&2; usage; exit 1 ;;
  esac
done

if [ -z "${FREESTYLE_API_KEY:-}" ]; then
  echo "error: FREESTYLE_API_KEY is required (same account that owns --snapshot)." >&2
  exit 1
fi

if [ -z "$SNAPSHOT" ]; then
  echo "error: --snapshot is required. Run ./setup.sh first, then pass its id." >&2
  exit 1
fi

CHECKOUT_DIR="${CHECKOUT_DIR:-$HOME/cmux-freestyle-cmux}"
WEB_DIR="$CHECKOUT_DIR/web"
ENV_PATH="$WEB_DIR/.env.local"

for tool in git bun; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool is required on PATH." >&2
    exit 1
  fi
done

if [ "$SKIP_CLONE" = 0 ]; then
  if [ -d "$CHECKOUT_DIR/.git" ]; then
    echo "[cmux-freestyle] updating cmux checkout at $CHECKOUT_DIR" >&2
    git -C "$CHECKOUT_DIR" fetch --quiet origin
    git -C "$CHECKOUT_DIR" checkout --quiet "$CMUX_REF"
    git -C "$CHECKOUT_DIR" pull --quiet --ff-only origin "$CMUX_REF" || true
  else
    echo "[cmux-freestyle] cloning manaflow-ai/cmux into $CHECKOUT_DIR (ref=$CMUX_REF)" >&2
    git clone --quiet --branch "$CMUX_REF" https://github.com/manaflow-ai/cmux.git "$CHECKOUT_DIR"
  fi
fi

if [ ! -d "$WEB_DIR" ]; then
  echo "error: $WEB_DIR not found. The clone may have failed, or use --no-clone with an existing cmux checkout." >&2
  exit 1
fi

if [ "$SKIP_INSTALL" = 0 ]; then
  echo "[cmux-freestyle] installing web deps with bun" >&2
  ( cd "$WEB_DIR" && bun install --silent )
fi

mkdir -p "$WEB_DIR"

if [ -f "$ENV_PATH" ]; then
  echo "[cmux-freestyle] $ENV_PATH already exists; appending only missing keys" >&2
fi

upsert_env() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" "$ENV_PATH" 2>/dev/null; then
    return
  fi
  printf '%s=%s\n' "$key" "$value" >> "$ENV_PATH"
}

touch "$ENV_PATH"

upsert_env FREESTYLE_API_KEY "$FREESTYLE_API_KEY"
upsert_env FREESTYLE_SANDBOX_SNAPSHOT "$SNAPSHOT"
upsert_env CMUX_VM_DEFAULT_PROVIDER "freestyle"
upsert_env CMUX_VM_FREESTYLE_ENABLED "1"
upsert_env CMUX_VM_E2B_ENABLED "0"
upsert_env CMUX_VM_PLAN_FREE_CREATE_CREDIT_ITEM_ID "none"
upsert_env CMUX_VM_CREATE_CREDIT_ITEM_ID "none"
upsert_env CMUX_VM_FREE_MAX_ACTIVE_VMS "5"
upsert_env CMUX_VM_ALLOWED_ORIGINS "http://127.0.0.1:3777,http://localhost:3777"

if [ -n "${STACK_SECRET_SERVER_KEY:-}" ]; then
  upsert_env STACK_SECRET_SERVER_KEY "$STACK_SECRET_SERVER_KEY"
fi
if [ -n "${NEXT_PUBLIC_STACK_PROJECT_ID:-}" ]; then
  upsert_env NEXT_PUBLIC_STACK_PROJECT_ID "$NEXT_PUBLIC_STACK_PROJECT_ID"
fi
if [ -n "${NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY:-}" ]; then
  upsert_env NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY "$NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY"
fi

if [ "$SKIP_POSTGRES" = 0 ]; then
  if command -v docker >/dev/null 2>&1; then
    echo "[cmux-freestyle] starting local Postgres via web/docker-compose.db.yml" >&2
    ( cd "$WEB_DIR" && bun db:up >/tmp/cmux-freestyle-db-up.log 2>&1 ) || \
      echo "warn: 'bun db:up' failed; see /tmp/cmux-freestyle-db-up.log" >&2
  else
    echo "warn: docker not found, skipping Postgres setup (pass --no-postgres to silence)." >&2
  fi
fi

cat <<EOF

cmux Next.js dev env is ready at $WEB_DIR
  env:    $ENV_PATH
  start:  cd $WEB_DIR && bun dev
  visit:  http://127.0.0.1:3777

Stack Auth keys are optional; sign-in routes will fail without them but the
Cloud VM API will work when called with X-Cmux-Team-Id headers.
EOF
