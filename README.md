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

## Subcommands

`./setup.sh` is a dispatcher. When called with no subcommand it builds the snapshot. The other subcommands cover the rest of a self-host:

```bash
./setup.sh                                # default: build snapshot (same as `./setup.sh snapshot`)
./setup.sh doctor                         # diagnose tooling, env, Freestyle API, GitHub release
./setup.sh web --snapshot sh-xxxxxxxxxx   # clone manaflow-ai/cmux and wire its Next.js dev env to your snapshot
./setup.sh home --ref feat-ink-rewrite    # install + run cmux-home, the Ink/TypeScript TUI dashboard
./setup.sh skills                         # install the cmux-freestyle agent skill into the current project
./setup.sh vm <action>                    # boot/fork/open a Freestyle VM and drive it from a cmux workspace
```

`web` clones `manaflow-ai/cmux` into `~/cmux-freestyle-cmux` by default, writes a `web/.env.local` with the right Freestyle and Cloud VM env, and starts a Docker Postgres unless you pass `--no-postgres`. It only depends on `git`, `bun`, and optionally `docker`. Stack Auth keys are honoured if set in the environment but are optional; the Cloud VM REST routes work without them when called with `X-Cmux-Team-Id`.

`home` installs the `cmux-home` Ink TUI (Node/Bun-only) so anyone with `node` can run a "headquarters" dashboard of their cmux workspaces. Use `--ref feat-ink-rewrite` until the Ink port lands on `main`. When `FREESTYLE_API_KEY` is in the env, the TUI also renders a `Freestyle VMs (N)` panel below the workspaces, hitting the Freestyle SDK directly so you can see VM state, snapshot id, and age in the same view as your cmux workspaces.

`skills` installs the `cmux-freestyle` agent skill from `skills/cmux-freestyle/SKILL.md` into the target project's `.agents/skills/cmux-freestyle/` and `.claude/skills/cmux-freestyle/`, following the cross-agent convention shared by Claude Code, Codex, OpenCode, Amp, Goose, and Gemini CLI. After install, an agent in that project knows how to operate `./setup.sh`, the env contract, the exact-semver pin policy, GitHub rate-limit recovery, the `./setup.sh vm` workflow (boot, fork, open), and how to plumb a snapshot id into a self-hosted cmux backend. Default mode is `--link` (symlink to this checkout, so `git pull` auto-upgrades). Pass `--copy` if you want to delete the cmux-freestyle clone later. Pass `--target <dir>` to install into a different project, `--check` for a dry run, `uninstall` to remove, `doctor` to inspect install state, and `list` to enumerate installable skills. `./skills.sh` works on its own too.

`vm` is the end-to-end dev loop. `./setup.sh vm boot <snapshotId>` boots a fresh VM, mints an ephemeral SSH identity + token, opens a cmux workspace already SSH'd into the VM, and adds a browser pane to the right wired to a `LocalForward` so the Mac browser hits the VM's dev server at `http://127.0.0.1:<localPort>/`. `./setup.sh vm fork <vmId>` clones a running VM (memory + disk) via `POST /v1/vms/{vm_id}/fork` and opens the fork in its own workspace, so two parallel branches of the same agent session run side by side. `./setup.sh vm open <vmId>` re-attaches an existing VM in a new workspace. `./setup.sh vm ssh <vmId> --json` prints the raw + cmux ssh command if you'd rather wire it manually. `./setup.sh vm list` and `./setup.sh vm delete <vmId>` cover the lifecycle. Pick a different `--local-port` for each concurrent workspace (default `17430`). Forks are SDK-only; the `freestyle` CLI does not surface fork directly.

## GitHub authentication

Snapshot builds resolve the cmuxd-remote release through public endpoints (`/repos/.../releases/latest` and `cmuxd-remote-checksums.txt`). The unauthenticated GitHub API allows 60 requests per hour, which is fine in normal use. If you hit a 403/429 (shared IP, CI loops), set `GITHUB_TOKEN` or `GH_TOKEN`. The build script forwards it on both the API and asset fetches and tells you when the limit was the cause.

The Freestyle SDK never touches GitHub; it only needs `FREESTYLE_API_KEY`.

## License

MIT, see `LICENSE`.
