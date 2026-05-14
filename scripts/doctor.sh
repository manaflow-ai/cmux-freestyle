#!/usr/bin/env bash
#
# Diagnose a cmux<>Freestyle setup. Checks tooling, env vars, and Freestyle
# API connectivity without changing anything.
#
# Usage:
#   ./scripts/doctor.sh

set -euo pipefail

had_fail=0
say() { printf '[%s] %s\n' "$1" "$2"; }
good() { say "OK" "$1"; }
warn() { say "WARN" "$1"; }
bad() { say "FAIL" "$1"; had_fail=1; }

check_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    good "$1 on PATH ($(command -v "$1"))"
  else
    bad "$1 not on PATH"
  fi
}

echo "== Tools =="
check_cmd bash
check_cmd curl
check_cmd git
check_cmd node || true
check_cmd bun || true
check_cmd docker || warn "docker not on PATH (only needed for ./setup.sh web)"

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(\".\")[0])' 2>/dev/null || echo "?")"
if [ "$NODE_MAJOR" != "?" ] && [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
  good "node major $NODE_MAJOR is >= 20"
elif command -v bun >/dev/null 2>&1; then
  good "bun available, node version irrelevant"
else
  bad "need node 20+ or bun"
fi

echo
echo "== Env =="
if [ -n "${FREESTYLE_API_KEY:-}" ]; then
  good "FREESTYLE_API_KEY set (len=${#FREESTYLE_API_KEY})"
else
  bad "FREESTYLE_API_KEY missing — required for snapshot + web"
fi

if [ -n "${FREESTYLE_SANDBOX_SNAPSHOT:-}" ]; then
  good "FREESTYLE_SANDBOX_SNAPSHOT=$FREESTYLE_SANDBOX_SNAPSHOT"
else
  warn "FREESTYLE_SANDBOX_SNAPSHOT unset — run ./setup.sh to mint one"
fi

if [ -n "${GITHUB_TOKEN:-}${GH_TOKEN:-}" ]; then
  good "GitHub token detected (raises the 60/hr unauthenticated API rate limit)"
else
  warn "No GITHUB_TOKEN/GH_TOKEN — the unauthenticated GitHub API allows 60 req/hr"
fi

echo
echo "== Freestyle API =="
if [ -n "${FREESTYLE_API_KEY:-}" ]; then
  STATUS=$(curl -s -o /tmp/cmux-freestyle-doctor.json -w '%{http_code}' \
    -H "Authorization: Bearer $FREESTYLE_API_KEY" \
    "https://api.freestyle.sh/v1/vms/snapshots?includeDeleted=false&includeFailed=true" || echo "000")
  case "$STATUS" in
    200)
      COUNT=$(python3 -c 'import json,sys; print(len(json.load(open("/tmp/cmux-freestyle-doctor.json")).get("snapshots", [])))' 2>/dev/null || echo "?")
      good "snapshots endpoint reachable, $COUNT snapshot(s) visible on this account"
      ;;
    401|403)
      bad "Freestyle returned $STATUS — API key invalid or revoked"
      ;;
    *)
      bad "Freestyle returned HTTP $STATUS (see /tmp/cmux-freestyle-doctor.json)"
      ;;
  esac
fi

echo
echo "== GitHub release =="
TAG=$(curl -fsS -H "User-Agent: cmux-freestyle-doctor" \
  ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} \
  https://api.github.com/repos/manaflow-ai/cmux/releases/latest 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tag_name",""))' 2>/dev/null || echo "")
if [ -n "$TAG" ]; then
  good "latest manaflow-ai/cmux release: $TAG"
else
  bad "could not resolve latest manaflow-ai/cmux release"
fi

echo
if [ "$had_fail" = 0 ]; then
  echo "Ready. Run ./setup.sh to build the snapshot, ./setup.sh web --snapshot <id> for the dev backend, ./setup.sh home for the TUI."
  exit 0
else
  echo "Some checks failed; fix the items above and re-run."
  exit 1
fi
