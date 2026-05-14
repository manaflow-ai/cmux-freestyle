# cmux-freestyle

Self-serve Freestyle snapshot for [cmux](https://github.com/manaflow-ai/cmux) Cloud VMs.

`./setup.sh` builds a Freestyle VM snapshot with `cmuxd-remote`, baked agent CLIs (Claude Code, Codex, OpenCode, Pi), Node, Bun, and the Python/OpenSSL shim that the cmux browser proxy needs. It prints a snapshot id you can plug into `FREESTYLE_SANDBOX_SNAPSHOT` for a self-hosted cmux backend, your own automation, or anything else that talks to the Freestyle API.

This is the same recipe the official cmux backend uses, distilled into a single repo and pinned to a published `cmuxd-remote` release on `manaflow-ai/cmux`, so you do not need an R2 bucket or a checkout of cmux to build it.

**Freestyle snapshots are scoped to the account that built them.** You cannot reuse a snapshot id from someone else's Freestyle account, including manaflow's. Everyone needs to run `./setup.sh` against their own `FREESTYLE_API_KEY` once.

## Requirements

- A Freestyle account and API key (`FREESTYLE_API_KEY`). Create one at https://dash.freestyle.sh.
- Node.js 20+ (Bun works too and is auto-detected).
- `curl` and `bash`.

## Quick start

```bash
git clone https://github.com/manaflow-ai/cmux-freestyle.git
cd cmux-freestyle
export FREESTYLE_API_KEY=fk_...
./setup.sh
```

Or, without a checkout:

```bash
export FREESTYLE_API_KEY=fk_...
curl -fsSL https://raw.githubusercontent.com/manaflow-ai/cmux-freestyle/main/install.sh | bash
```

The build takes ~5 to 15 minutes depending on Freestyle's cache. When it finishes, the script prints:

```text
FREESTYLE_SANDBOX_SNAPSHOT=sh-xxxxxxxxxxxxxxxxxxxx
```

That env line is the integration point.

## What goes into the snapshot

The snapshot is built from a Dockerfile that mirrors `repo/web/scripts/build-cloud-vm-images.ts` in cmux:

- `ubuntu:24.04` with `bash`, `ca-certificates`, `curl`, `git`, `gnupg`, `openssl`, `python3`, `sudo`, `unzip`, `xz-utils`, plus `C.UTF-8` locale.
- Python launcher patched to load `libssl3` from `/opt/cmux/openssl/lib` so the cmux browser proxy works without provider-side TLS surprises.
- `cmuxd-remote` Linux/amd64 binary downloaded from the pinned `manaflow-ai/cmux` GitHub release, SHA-256 verified during the image build.
- `/usr/local/bin/cmux` symlinked to `cmuxd-remote` for the in-VM relay CLI.
- Node.js (default major `22`) from NodeSource, Bun pinned to a known good tag.
- Coding agents pinned to the same versions cmux ships: `@anthropic-ai/claude-code`, `opencode-ai`, `@openai/codex`, `@earendil-works/pi-coding-agent`.
- Linux user `cmux` with passwordless sudo.
- Systemd unit `cmuxd-ws.service` running `cmuxd-remote serve --ws --listen 0.0.0.0:7777` with lease-file authentication, exposed on Freestyle port `443 -> 7777`.

The image performs the same smoke checks cmux runs at build time (`openssl version -a`, `python3 -c 'import ssl'`, `node --version`, `bun --version`, `cmux --help`, `cmuxd-remote version`, plus `--version` for every baked agent CLI).

## Options

Set these as flags on `./setup.sh` or as env vars:

| Flag | Env var | Default | Notes |
| --- | --- | --- | --- |
| `--name <name>` | `CMUX_FREESTYLE_SNAPSHOT_NAME` | `cmux-freestyle-<timestamp>` | Snapshot name in Freestyle. |
| `--release <tag>` | `CMUX_RELEASE_TAG` | latest stable `manaflow-ai/cmux` release | Pin to a specific cmux release tag (for example `v0.9.42`). |
| `--node-major <n>` | `CMUX_CLOUD_IMAGE_NODE_MAJOR` | `22` | NodeSource major line. |
| `--bun-version <semver>` | `CMUX_CLOUD_IMAGE_BUN_VERSION` | matches cmux pin | Exact `oven-sh/bun` release. |
| `--claude-spec <npm-spec>` | `CMUX_CLOUD_IMAGE_CLAUDE_CODE_NPM_SPEC` | matches cmux pin | Use `none` to skip Claude Code. |
| `--codex-spec <npm-spec>` | `CMUX_CLOUD_IMAGE_CODEX_NPM_SPEC` | matches cmux pin | Use `none` to skip Codex. |
| `--opencode-spec <npm-spec>` | `CMUX_CLOUD_IMAGE_OPENCODE_NPM_SPEC` | matches cmux pin | Use `none` to skip OpenCode. |
| `--pi-spec <npm-spec>` | `CMUX_CLOUD_IMAGE_PI_NPM_SPEC` | matches cmux pin | Use `none` to skip Pi. |
| `--skip-cache` | `CMUX_FREESTYLE_SKIP_CACHE=1` | off | Forces a full Freestyle rebuild. |
| `--json` | `CMUX_FREESTYLE_JSON=1` | off | Machine-readable JSON output. |

Agent CLI specs must be exact semver pins (for example `@openai/codex@0.130.0`), matching cmux's policy. Ranges and `latest` are rejected so each rebuild is reproducible.

## Using the snapshot

For a self-hosted cmux web backend, set:

```bash
FREESTYLE_API_KEY=fk_...
FREESTYLE_SANDBOX_SNAPSHOT=sh-xxxxxxxxxxxxxxxxxxxx
CMUX_VM_DEFAULT_PROVIDER=freestyle
CMUX_VM_FREESTYLE_ENABLED=1
```

For ad-hoc use, boot a VM from your snapshot:

```bash
npx -y freestyle vm create --snapshot sh-xxxxxxxxxxxxxxxxxxxx --ssh
```

You will land in a cmux Cloud VM shell with `cmuxd-remote`, `claude`, `codex`, `opencode`, `pi`, `bun`, and `node` already on `PATH`.

## Rebuilding

Re-run `./setup.sh` whenever you want a fresh snapshot, for example after a new `manaflow-ai/cmux` release or after bumping pinned agent CLI versions. Each run produces a new snapshot id under your Freestyle account; old ones stay around until you delete them through the Freestyle dashboard or API.

## License

MIT, see `LICENSE`.
