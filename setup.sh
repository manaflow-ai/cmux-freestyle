#!/usr/bin/env bash
#
# cmux-freestyle: build Freestyle VM snapshots and drive them from cmux.
# Designed to be invoked from a clone of manaflow-ai/cmux-freestyle.
#
# Credentials: setup.sh resolves a Freestyle API key from (in order):
#   1. the running env
#   2. ./.env in this checkout
#   3. ~/.config/cmux-freestyle/.env
#   4. ~/.secrets/cmux-freestyle.env
#   5. ~/.secrets/cmux.env
# Use `./setup.sh secrets set` to seed (3) interactively; `./setup.sh secrets
# check` to verify; `./setup.sh secrets show` to inspect (key is masked).
#
# Other flags / env: see README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SECRET_SOURCES=(
  "$SCRIPT_DIR/.env"
  "$HOME/.config/cmux-freestyle/.env"
  "$HOME/.secrets/cmux-freestyle.env"
  "$HOME/.secrets/cmux.env"
)
CMUX_FREESTYLE_SECRET_SOURCE=""

load_secrets() {
  # Don't probe sources when the user explicitly opted out, but still respect
  # an already-exported key in the env.
  if [ -n "${CMUX_FREESTYLE_SKIP_DOTENV:-}" ]; then
    if [ -n "${FREESTYLE_API_KEY:-}" ]; then
      CMUX_FREESTYLE_SECRET_SOURCE="env"
      return 0
    fi
    return 1
  fi
  if [ -n "${FREESTYLE_API_KEY:-}" ]; then
    CMUX_FREESTYLE_SECRET_SOURCE="env"
    return 0
  fi
  local src
  for src in "${SECRET_SOURCES[@]}"; do
    if [ -f "$src" ] && grep -q '^FREESTYLE_API_KEY=' "$src" 2>/dev/null; then
      # shellcheck disable=SC1090
      set -a
      . "$src"
      set +a
      if [ -n "${FREESTYLE_API_KEY:-}" ]; then
        CMUX_FREESTYLE_SECRET_SOURCE="$src"
        return 0
      fi
    fi
  done
  return 1
}

mask_key() {
  local k="$1"
  if [ "${#k}" -le 12 ]; then
    printf '****'
  else
    printf '%s...%s' "${k:0:6}" "${k: -4}"
  fi
}

print_search_paths() {
  local src
  for src in "${SECRET_SOURCES[@]}"; do
    printf '    %s\n' "$src" >&2
  done
}

# Always probe; subcommands that don't need credentials simply ignore the
# result. Subcommands that need credentials enforce below.
load_secrets || true

PEEK_SUB="snapshot"
if [ $# -gt 0 ]; then
  case "$1" in
    snapshot|home|web|doctor|skills|vm|secrets) PEEK_SUB="$1" ;;
  esac
fi

if [ "$PEEK_SUB" = "snapshot" ] || [ "$PEEK_SUB" = "web" ] || [ "$PEEK_SUB" = "vm" ]; then
  if [ -z "${FREESTYLE_API_KEY:-}" ]; then
    echo "error: '$PEEK_SUB' needs Freestyle credentials and none were resolved." >&2
    echo "  set them up once with:" >&2
    echo "    ./setup.sh secrets set     # paste your key, hidden input" >&2
    echo "    ./setup.sh secrets check   # verify" >&2
    echo "  setup.sh searches, in order:" >&2
    print_search_paths
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
    echo "error: need either bun or node 20+ on PATH for '$PEEK_SUB'." >&2
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
    snapshot|home|web|doctor|skills|vm|secrets) SUBCOMMAND="$1"; shift ;;
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
  secrets)
    ACTION="${1:-check}"
    shift || true
    case "$ACTION" in
      check)
        if [ -n "${FREESTYLE_API_KEY:-}" ]; then
          printf 'freestyle credentials: ok\n  source: %s\n' "$CMUX_FREESTYLE_SECRET_SOURCE"
          exit 0
        fi
        echo "freestyle credentials: MISSING" >&2
        echo "  set them up once with: ./setup.sh secrets set" >&2
        echo "  setup.sh searches, in order:" >&2
        print_search_paths
        exit 1
        ;;
      set)
        DEST="$HOME/.config/cmux-freestyle/.env"
        KEY=""
        while [ $# -gt 0 ]; do
          case "$1" in
            --key) KEY="${2:?--key needs a value}"; shift 2 ;;
            --dest) DEST="${2:?--dest needs a value}"; shift 2 ;;
            -h|--help)
              cat <<'USAGE'
Usage: ./setup.sh secrets set [--key fk_...] [--dest path]

If --key is omitted, prompts on the tty with hidden input. If stdin is
piped, reads the key from stdin. Default dest: ~/.config/cmux-freestyle/.env
USAGE
              exit 0
              ;;
            *) echo "unknown flag: $1" >&2; exit 2 ;;
          esac
        done
        if [ -z "$KEY" ]; then
          if [ -t 0 ]; then
            printf 'Paste your Freestyle API key (input hidden, https://dash.freestyle.sh): ' >&2
            stty -echo
            trap 'stty echo' EXIT INT
            IFS= read -r KEY
            stty echo
            trap - EXIT INT
            printf '\n' >&2
          else
            IFS= read -r KEY
          fi
        fi
        if [ -z "$KEY" ]; then
          echo "error: no key provided" >&2
          exit 1
        fi
        mkdir -p "$(dirname "$DEST")"
        chmod 700 "$(dirname "$DEST")" 2>/dev/null || true
        umask 077
        printf 'FREESTYLE_API_KEY=%s\n' "$KEY" > "$DEST"
        chmod 600 "$DEST"
        echo "wrote $DEST"
        echo "verify with: ./setup.sh secrets check"
        ;;
      show)
        if [ -n "${FREESTYLE_API_KEY:-}" ]; then
          printf 'source: %s\nkey:    %s (len=%d)\n' \
            "$CMUX_FREESTYLE_SECRET_SOURCE" \
            "$(mask_key "$FREESTYLE_API_KEY")" \
            "${#FREESTYLE_API_KEY}"
          exit 0
        fi
        echo "no key found" >&2
        exit 1
        ;;
      where)
        if [ -n "${FREESTYLE_API_KEY:-}" ]; then
          printf '%s\n' "$CMUX_FREESTYLE_SECRET_SOURCE"
          exit 0
        fi
        exit 1
        ;;
      paths)
        for src in "${SECRET_SOURCES[@]}"; do
          printf '%s\n' "$src"
        done
        ;;
      -h|--help|help|*)
        cat <<'USAGE'
Usage: ./setup.sh secrets <subcommand>

  check                       exit 0 if a key is resolved (default)
  set [--key fk_...] [--dest path]
                              write a key to the dest file (default
                              ~/.config/cmux-freestyle/.env). With no
                              --key, prompts hidden on tty or reads stdin.
  show                        print masked key and its source
  where                       print only the source path of the resolved key
  paths                       print the full search path list
USAGE
        case "$ACTION" in
          -h|--help|help) exit 0 ;;
          *) exit 2 ;;
        esac
        ;;
    esac
    ;;
  *)
    echo "unknown subcommand: $SUBCOMMAND" >&2
    exit 1
    ;;
esac
