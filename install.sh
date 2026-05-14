#!/usr/bin/env bash
#
# Bootstrap installer for cmux-freestyle.
#
# Usage:
#   FREESTYLE_API_KEY=fk_... curl -fsSL https://raw.githubusercontent.com/manaflow-ai/cmux-freestyle/main/install.sh | bash
#
# This clones manaflow-ai/cmux-freestyle into ~/.cmux-freestyle (or
# $CMUX_FREESTYLE_HOME), then runs ./setup.sh.

set -euo pipefail

REPO_URL="${CMUX_FREESTYLE_REPO_URL:-https://github.com/manaflow-ai/cmux-freestyle.git}"
INSTALL_DIR="${CMUX_FREESTYLE_HOME:-$HOME/.cmux-freestyle}"

if [ -z "${FREESTYLE_API_KEY:-}" ]; then
  echo "error: FREESTYLE_API_KEY is required." >&2
  echo "  FREESTYLE_API_KEY=fk_... bash install.sh" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "error: git is required to fetch cmux-freestyle." >&2
  exit 1
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "[cmux-freestyle] updating existing checkout at $INSTALL_DIR" >&2
  git -C "$INSTALL_DIR" fetch --quiet origin
  git -C "$INSTALL_DIR" reset --quiet --hard origin/HEAD
else
  echo "[cmux-freestyle] cloning $REPO_URL into $INSTALL_DIR" >&2
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --quiet "$REPO_URL" "$INSTALL_DIR"
fi

exec "$INSTALL_DIR/setup.sh" "$@"
