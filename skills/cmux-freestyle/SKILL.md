---
name: cmux-freestyle
description: Build, troubleshoot, and ship cmux Cloud VM snapshots on a personal Freestyle account from the manaflow-ai/cmux-freestyle repo. Use when the user wants to mint a FREESTYLE_SANDBOX_SNAPSHOT, run ./setup.sh (snapshot|doctor|web|home), bump pinned cmuxd-remote or agent CLI versions, recover from GitHub API rate limits during a snapshot build, wire the snapshot id into a self-hosted cmux backend, or boot an ad-hoc VM from the resulting snapshot.
---

# cmux-freestyle

This repo is the self-serve recipe for the cmux Cloud VM image. `./setup.sh` builds a Freestyle VM snapshot containing `cmuxd-remote`, baked agent CLIs (Claude Code, Codex, OpenCode, Pi), Node, Bun, and the Python/OpenSSL shim the cmux browser proxy needs. The output is `FREESTYLE_SANDBOX_SNAPSHOT=sh-...`, which is the integration handoff for a self-hosted cmux backend or any Freestyle SDK consumer.

Snapshots are scoped to the Freestyle account that built them. A snapshot id from another account, including manaflow's, will not resolve. Every consumer runs `./setup.sh` once against their own `FREESTYLE_API_KEY`.

## Dispatcher

```bash
./setup.sh                                # default: snapshot
./setup.sh snapshot [flags]               # build + publish a Freestyle snapshot
./setup.sh doctor                         # diagnose tooling, env, Freestyle API, GitHub release
./setup.sh web --snapshot sh-...          # clone manaflow-ai/cmux and wire its Next.js dev env
./setup.sh home --ref feat-ink-rewrite    # install + run the cmux-home Ink TUI
./setup.sh skills [install|...]           # install the cmux-freestyle agent skill into a project
```

`./setup.sh` auto-loads `.env` (skip with `CMUX_FREESTYLE_SKIP_DOTENV=1`). The dispatcher requires Bun or Node 20+ for `snapshot` only; `doctor`, `home`, `skills` are pure bash.

## Env contract

Required:

- `FREESTYLE_API_KEY` (snapshot, web). Get one at https://dash.freestyle.sh.

Optional:

- `GITHUB_TOKEN` or `GH_TOKEN` raises the 60 req/hr unauthenticated GitHub API limit. The build forwards it to both the release API and the asset download.
- `CMUX_FREESTYLE_SNAPSHOT_NAME` snapshot name. Default `cmux-freestyle-<timestamp>`.
- `CMUX_RELEASE_TAG` pin a specific `manaflow-ai/cmux` release tag (e.g. `v0.9.42`). Default: latest stable release.
- `CMUX_CLOUD_IMAGE_NODE_MAJOR` NodeSource major line. Default `22`.
- `CMUX_CLOUD_IMAGE_BUN_VERSION` exact `oven-sh/bun` release.
- `CMUX_CLOUD_IMAGE_CLAUDE_CODE_NPM_SPEC` exact semver, or `none` to skip.
- `CMUX_CLOUD_IMAGE_CODEX_NPM_SPEC` exact semver, or `none` to skip.
- `CMUX_CLOUD_IMAGE_OPENCODE_NPM_SPEC` exact semver, or `none` to skip.
- `CMUX_CLOUD_IMAGE_PI_NPM_SPEC` exact semver, or `none` to skip.
- `CMUX_FREESTYLE_SKIP_CACHE=1` forces a full Freestyle rebuild.
- `CMUX_FREESTYLE_JSON=1` (or `--json`) machine-readable output.

Every env var has a matching `--flag` on `./setup.sh snapshot`. See `README.md` for the table.

## Pin policy

Agent CLI specs are exact semver (e.g. `@openai/codex@0.130.0`). Ranges (`^1.2`, `~1.2`) and `latest` are rejected so every rebuild is reproducible. Use `none` to omit a CLI entirely. When bumping a pinned spec, change the env var or pass a flag and re-run `./setup.sh`; do not loosen the spec.

## Snapshot lifecycle

- Each successful build mints a new snapshot id. Old ones persist until deleted in the Freestyle dashboard or via the Freestyle API.
- Builds take roughly 5 to 15 minutes depending on Freestyle's cache hit rate.
- The image runs smoke checks during build: `openssl version -a`, `python3 -c 'import ssl'`, `node --version`, `bun --version`, `cmux --help`, `cmuxd-remote version`, plus `--version` for every baked agent CLI. A failure surfaces in the build log.
- `cmuxd-remote` is downloaded from the pinned `manaflow-ai/cmux` release and SHA-256 verified against `cmuxd-remote-checksums.txt` during the build.

## Plumbing into a self-hosted cmux backend

After a snapshot build, set in your cmux web `.env.local`:

```bash
FREESTYLE_API_KEY=fk_...
FREESTYLE_SANDBOX_SNAPSHOT=sh-xxxxxxxxxxxxxxxxxxxx
CMUX_VM_DEFAULT_PROVIDER=freestyle
CMUX_VM_FREESTYLE_ENABLED=1
```

`./setup.sh web --snapshot sh-...` writes this for you when wiring up a fresh `manaflow-ai/cmux` checkout (default location `~/cmux-freestyle-cmux`), and starts a Docker Postgres unless you pass `--no-postgres`. Stack Auth keys are honoured if set but optional; the Cloud VM REST routes accept `X-Cmux-Team-Id` without auth.

## Ad-hoc VM boot

```bash
npx -y freestyle vm create --snapshot sh-xxxxxxxxxxxxxxxxxxxx --ssh
```

Lands you in a Cloud VM shell with `cmuxd-remote`, `claude`, `codex`, `opencode`, `pi`, `bun`, and `node` already on PATH.

## Recovery playbook

- GitHub 403/429 on release lookup: set `GITHUB_TOKEN` or `GH_TOKEN`. The build script tells you when the rate limit was the cause.
- Build cache misbehaves or you want a clean run: `./setup.sh snapshot --skip-cache` or `CMUX_FREESTYLE_SKIP_CACHE=1`.
- `bun` or `node` missing: `./setup.sh doctor` reports it. Install bun: `curl -fsSL https://bun.sh/install | bash`. Install node 20+ from nodejs.org or the platform package manager.
- Need machine-readable output for CI: `--json` or `CMUX_FREESTYLE_JSON=1`.
- API key invalid or revoked: `./setup.sh doctor` returns FAIL with HTTP 401/403 from the Freestyle snapshots endpoint.
- Snapshot id from someone else not working: it cannot work. Run `./setup.sh` against your own `FREESTYLE_API_KEY`.

## Rules

- Never loosen agent CLI specs to ranges or `latest`. The build rejects them.
- Never share or hard-code another account's snapshot id; it will not resolve.
- The Freestyle SDK only needs `FREESTYLE_API_KEY`. It never touches GitHub.
- Rebuild after every new `manaflow-ai/cmux` release if you want the new `cmuxd-remote`. Re-run `./setup.sh`.
- For a self-hosted cmux backend, set both `FREESTYLE_API_KEY` and `FREESTYLE_SANDBOX_SNAPSHOT`, plus `CMUX_VM_DEFAULT_PROVIDER=freestyle` and `CMUX_VM_FREESTYLE_ENABLED=1`.
- Prefer `./setup.sh doctor` before reaching for ad-hoc curl debugging. It already covers tooling, env, Freestyle reachability, and GitHub release resolution.
