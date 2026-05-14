#!/usr/bin/env bash
#
# cmux-freestyle skills installer.
#
# Installs the cmux-freestyle agent skill into a target project so AI coding
# agents (Claude Code, Codex, OpenCode, Amp, Goose, Gemini CLI, etc.) can
# operate the ./setup.sh snapshot/web/home/doctor flows without the user
# having to paste the README on every chat.
#
# Layout follows the cross-agent convention used by cmuxterm-hq and others:
#
#   <target>/.agents/skills/<name>/SKILL.md   # Codex, OpenCode, Amp, Goose, Gemini CLI
#   <target>/.claude/skills/<name>/SKILL.md   # Claude Code
#
# By default skills are installed as symlinks pointing at this checkout, so
# `git pull` in this repo updates every project that installed them. Pass
# --copy to drop standalone copies instead (useful when you want to remove
# the cmux-freestyle clone later).
#
# Usage:
#   ./skills.sh                                  # install all skills into $PWD
#   ./skills.sh install [opts] [name...]         # install named skills (default: all)
#   ./skills.sh list                             # list installable skills
#   ./skills.sh uninstall [opts] [name...]       # remove installed skills
#   ./skills.sh doctor [--target <dir>]          # report install state
#
# Options for install/uninstall:
#   --target <dir>   Target project root (default: $PWD)
#   --link           Symlink (default; requires a stable checkout location)
#   --copy           Copy instead of symlinking (for ephemeral checkouts)
#   --check          Dry run; print actions without changing anything
#   -h, --help       Show this message
#
# Examples:
#   ./skills.sh install --target ~/code/my-app
#   ./skills.sh install --copy
#   ./skills.sh uninstall cmux-freestyle
#   ./skills.sh doctor --target ~/code/my-app

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$SCRIPT_DIR/skills"
SURFACES=(.agents/skills .claude/skills)

usage() {
  sed -n '2,42p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

list_skills() {
  if [ ! -d "$SKILLS_SRC" ]; then
    echo "no skills directory at $SKILLS_SRC" >&2
    return 1
  fi
  local found=0
  for skill in "$SKILLS_SRC"/*/SKILL.md; do
    [ -f "$skill" ] || continue
    found=1
    local name desc
    name="$(basename "$(dirname "$skill")")"
    desc="$(awk '
      BEGIN { in_fm=0 }
      /^---[[:space:]]*$/ { in_fm = !in_fm; next }
      in_fm && /^description:[[:space:]]*/ {
        sub(/^description:[[:space:]]*/, "")
        print
        exit
      }
    ' "$skill")"
    printf '%s\t%s\n' "$name" "${desc:-(no description)}"
  done
  if [ "$found" = 0 ]; then
    echo "no skills found under $SKILLS_SRC" >&2
    return 1
  fi
}

resolve_skills() {
  if [ "$#" -gt 0 ]; then
    local name
    for name in "$@"; do
      if [ ! -f "$SKILLS_SRC/$name/SKILL.md" ]; then
        echo "error: unknown skill '$name' (no $SKILLS_SRC/$name/SKILL.md)" >&2
        return 1
      fi
      printf '%s\n' "$name"
    done
  else
    local skill
    for skill in "$SKILLS_SRC"/*/SKILL.md; do
      [ -f "$skill" ] || continue
      basename "$(dirname "$skill")"
    done
  fi
}

# Print the path to which a previously-installed skill points, or empty if
# the destination is missing.
existing_target() {
  local dst="$1"
  if [ -L "$dst" ]; then
    readlink "$dst"
  elif [ -d "$dst" ]; then
    printf '%s' "$dst"
  fi
}

install_one() {
  local name="$1" target="$2" mode="$3" check="$4"
  local src="$SKILLS_SRC/$name"
  local surface dst existing
  for surface in "${SURFACES[@]}"; do
    dst="$target/$surface/$name"
    existing="$(existing_target "$dst" || true)"
    if [ "$check" = 1 ]; then
      if [ -n "$existing" ]; then
        printf 'would replace: %s (was -> %s) [%s]\n' "$dst" "$existing" "$mode"
      else
        printf 'would install: %s [%s]\n' "$dst" "$mode"
      fi
      continue
    fi
    mkdir -p "$(dirname "$dst")"
    rm -rf "$dst"
    case "$mode" in
      link) ln -s "$src" "$dst" ;;
      copy) cp -R "$src" "$dst" ;;
      *) echo "error: unknown mode '$mode'" >&2; return 1 ;;
    esac
    printf 'installed: %s -> %s\n' "$dst" "$src"
  done
}

uninstall_one() {
  local name="$1" target="$2" check="$3"
  local surface dst removed=0
  for surface in "${SURFACES[@]}"; do
    dst="$target/$surface/$name"
    if [ ! -e "$dst" ] && [ ! -L "$dst" ]; then
      continue
    fi
    removed=1
    if [ "$check" = 1 ]; then
      printf 'would remove: %s\n' "$dst"
      continue
    fi
    rm -rf "$dst"
    printf 'removed: %s\n' "$dst"
  done
  if [ "$removed" = 0 ] && [ "$check" = 1 ]; then
    printf 'no installs of %s under %s\n' "$name" "$target"
  fi
}

doctor() {
  local target="$1"
  printf 'cmux-freestyle skills doctor\n'
  printf '  source: %s\n' "$SKILLS_SRC"
  printf '  target: %s\n' "$target"
  printf '\n'
  local any=0
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    any=1
    printf '%s:\n' "$name"
    local surface dst
    for surface in "${SURFACES[@]}"; do
      dst="$target/$surface/$name"
      if [ -L "$dst" ]; then
        local resolved
        resolved="$(readlink "$dst")"
        if [ -e "$dst" ]; then
          printf '  %-30s -> %s (link, ok)\n' "$surface/$name" "$resolved"
        else
          printf '  %-30s -> %s (BROKEN link)\n' "$surface/$name" "$resolved"
        fi
      elif [ -d "$dst" ]; then
        if [ -f "$dst/SKILL.md" ]; then
          printf '  %-30s (copy, ok)\n' "$surface/$name"
        else
          printf '  %-30s (directory present but no SKILL.md)\n' "$surface/$name"
        fi
      else
        printf '  %-30s (missing)\n' "$surface/$name"
      fi
    done
  done < <(resolve_skills)
  if [ "$any" = 0 ]; then
    echo 'no skills in this checkout' >&2
    return 1
  fi
}

SUB="install"
if [ $# -gt 0 ]; then
  case "$1" in
    install|uninstall|list|doctor) SUB="$1"; shift ;;
    -h|--help) usage; exit 0 ;;
  esac
fi

TARGET="$PWD"
MODE="link"
CHECK=0
NAMES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:?--target needs a value}"; shift 2 ;;
    --link) MODE="link"; shift ;;
    --copy) MODE="copy"; shift ;;
    --check) CHECK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; while [ $# -gt 0 ]; do NAMES+=("$1"); shift; done ;;
    -*) echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
    *) NAMES+=("$1"); shift ;;
  esac
done

case "$SUB" in
  list)
    list_skills
    ;;
  install)
    if [ ! -d "$TARGET" ]; then
      echo "error: target dir '$TARGET' does not exist" >&2
      exit 1
    fi
    TARGET="$(cd "$TARGET" && pwd)"
    if [ "$TARGET" = "$SCRIPT_DIR" ] && [ "$MODE" = "link" ]; then
      echo "[skills.sh] target == this checkout; skipping (nothing to install into itself)" >&2
      exit 0
    fi
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      install_one "$name" "$TARGET" "$MODE" "$CHECK"
    done < <(resolve_skills "${NAMES[@]}")
    ;;
  uninstall)
    if [ ! -d "$TARGET" ]; then
      echo "error: target dir '$TARGET' does not exist" >&2
      exit 1
    fi
    TARGET="$(cd "$TARGET" && pwd)"
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      uninstall_one "$name" "$TARGET" "$CHECK"
    done < <(resolve_skills "${NAMES[@]}")
    ;;
  doctor)
    if [ ! -d "$TARGET" ]; then
      echo "error: target dir '$TARGET' does not exist" >&2
      exit 1
    fi
    TARGET="$(cd "$TARGET" && pwd)"
    doctor "$TARGET"
    ;;
  *)
    echo "unknown subcommand: $SUB" >&2
    usage >&2
    exit 2
    ;;
esac
