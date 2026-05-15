---
name: cmux-freestyle
description: Drive cmux + Freestyle Cloud VMs end to end from the manaflow-ai/cmux-freestyle repo. Use when the user wants to boot a Freestyle VM from a snapshot, fork an existing VM to clone its running state, open a cmux workspace already SSH'd into a VM with a dev-server LocalForward, lay out codex on the left and a browser on the right pointed at the VM's localhost dev server, or set up a self-serve cmux + Freestyle workflow.
---

# cmux-freestyle

cmux-freestyle gives you everything you need to spin a fresh Freestyle Cloud VM and drive it from a cmux workspace as if it were local.

## Transport: cmuxd-ws WebSocket, not ssh

Default cmux ssh against `vm-ssh.freestyle.sh` does not work — the gateway is a russh-based forwarder that rejects exec channels, so cmux's daemon bootstrap (`scp cmuxd-remote`, `cmuxd-remote serve --stdio`) stalls and the workspace loops on `exec request failed on channel 0; reconnecting (attempt N/20)`. Even with `--no-daemon-bootstrap`, you lose cmux's auto port-forwarding and have to hand-roll `ssh -L` per port.

The cmux-freestyle snapshot already runs `cmuxd-remote serve --ws --listen 0.0.0.0:7777` as a systemd unit (`cmuxd-ws.service`), and the snapshot template exposes `{port: 443, targetPort: 7777}`, so freestyle's gateway forwards `https://<vmId>.vm.freestyle.sh/` straight to the daemon. The right attach path is therefore **WebSocket**, matching what `cmux vm new` does for freestyle in the bundled cmux app:

1. Mint two short-lived leases (PTY + RPC). Each lease is `{version:1, token_sha256, expires_at_unix, session_id, single_use}` (see `repo/web/services/vms/drivers/wsLease.ts`).
2. Write them into the VM via `fs.vms.ref({vmId}).exec(...)` at:
   - `/tmp/cmux/attach-pty-lease.json`
   - `/tmp/cmux/attach-rpc-lease.json`
3. `systemctl restart cmuxd-ws.service` so the daemon picks the fresh leases up.
4. `cmux rpc workspace.create` with `initial_command="cmux vm-pty-connect --config <path>"`. The config JSON is `{url:"wss://<domain>/terminal", headers:{}, token, sessionId}`. cmux's bundled `vm-pty-connect` bridges stdio ↔ WebSocket frames.
5. `cmux rpc workspace.remote.configure` with `transport=websocket`, `skip_daemon_bootstrap=true`, and the same daemon URL/token/sessionId/expiresAtUnix for the RPC endpoint (`wss://<domain>/rpc`).
6. `cmux rpc workspace.select`.

Result: workspace sidebar shows `ws:connected, daemon: ready`. cmux's proxy + port-forwarding RPC works just like for `cmux vm new`. No ssh dance, no per-port `-L`.

The mint+install+attach is implemented in `cmux-home/ink/src/cmux-ws.ts` (`prepareFreestyleWsAttach`, `openCmuxWsWorkspace`). The reference cmux-side code is `repo/CLI/cmux.swift:runVMPtyWebSocketWorkspace` and `repo/web/services/vms/drivers/freestyle.ts:openWebSocketPty`.

**Health probe before attaching.** Hit `https://<vmId>.vm.freestyle.sh/healthz` first; cmuxd-remote replies `{"locked":true,"ok":true}` (HTTP 200, content-type application/json). If you get a `text/html` openresty page instead, the snapshot doesn't have `cmuxd-ws.service` running or wasn't built with the `ports: [{port:443, targetPort:7777}]` template config — rebuild it.

## "Start a new workspace" — the default

When the user says **"start a new workspace"**, "spin up a new VM", "set up a fresh workspace", or anything in that family, the helper produces this exact 2x2 cmux workspace:

- **top-left:** `codex` already running on the VM, ready for input
- **bottom-left:** empty terminal on the VM, ready for ad-hoc commands
- **bottom-right:** runs `git clone --depth 1 https://github.com/manaflow-ai/cmux && cd cmux && bun install && bun dev` on a fresh ssh session
- **top-right:** cmux browser that auto-navigates to `http://127.0.0.1:<localPort>/` (forwarded to the VM's `:3000`) once the dev server responds

The single entrypoint is:

```bash
./setup.sh secrets check     # always pre-flight
./setup.sh vm new            # uses $FREESTYLE_SANDBOX_SNAPSHOT by default
```

`vm new` boots a fresh VM from the configured snapshot, mints one Freestyle token (raw ssh handles three concurrent sessions per token cleanly, no per-pane creds needed), creates a local cmux workspace, sends raw `ssh` to each of the three terminal panes (TL with the LocalForward, BL/BR plain), waits for the BR remote prompt before kicking off the dev cmd, waits for the dev URL, then reloads the browser pane. To override:

```bash
./setup.sh vm new <snapshotId|vmId> \
  [--local-port 17430]   # Mac-side forwarded port; bump per concurrent workspace
  [--vm-port 3000]       # dev server port inside the VM
  [--name myws]          # workspace title in the cmux sidebar
  [--dev-cmd "..."]      # override the cmux clone+install+dev preset
  [--skip-dev]           # leave bottom-right empty, no dev server
  [--skip-codex]         # leave top-left empty, don't launch codex
```

Pass a vmId instead of a snapshotId to attach this layout to an already-running VM instead of booting fresh.

**The snapshot must have `bun`, `node`, `npm`, `codex`, `claude`, `opencode`, `pi` preinstalled** for the dev-cmd and codex launch to work. `./setup.sh snapshot` builds one with all of those. A blank Ubuntu snapshot (only `git`, `python3`, `curl`) won't run the default `vm new` flow. If `./setup.sh vm new` boots and the BR pane reports `bun: command not found` or `codex: command not found`, your `$FREESTYLE_SANDBOX_SNAPSHOT` is pointing at a stripped snapshot, not a cmux-cloud one. Rebuild with `./setup.sh snapshot` or pick a richer existing snapshot id.

Note: at HEAD the root `package.json` of `manaflow-ai/cmux` does not have a `dev` script, so `bun dev` after `bun install` will print `error: Script not found "dev"`. The clone, install, and layout still come up correctly. Override `--dev-cmd` (e.g. `--dev-cmd "git clone --depth 1 https://github.com/manaflow-ai/cmux && cd cmux/web && bun install && bun dev"`) when you want the docs-site dev server actually running.

Underlying primitives (`vm boot|fork|open|dev|ssh|list|delete`) are documented below and still available when you want a non-default layout.

## Credentials (always probe setup.sh first)

Never ask the user for a Freestyle API key directly. setup.sh owns credential resolution and has its own search chain. Pre-flight every Freestyle action with:

```bash
./setup.sh secrets check
```

- Exit `0`: credentials are resolved. The dispatcher will pass them to every subcommand that needs them. Proceed.
- Non-zero: no credentials anywhere. Tell the user once, then have them run `./setup.sh secrets set` (interactive, input hidden) or `./setup.sh secrets set --key <their-key> --dest ~/.config/cmux-freestyle/.env` (scripted). Re-run `./setup.sh secrets check` to confirm, then proceed.

Other useful queries:

- `./setup.sh secrets where` prints just the source file path that satisfied resolution.
- `./setup.sh secrets show` prints the masked key and source.
- `./setup.sh secrets paths` prints the full search list (useful when explaining to the user where setup.sh looked).

The skill does not need to know the env var name or any specific dotfile. Treat `./setup.sh secrets *` as the only credential surface and never paste a key into chat or commit it.

A Freestyle snapshot id is also needed for `vm boot`. Build one with `./setup.sh snapshot` or list existing ones with `./setup.sh vm list`.

## Subcommands

```bash
./setup.sh vm new    [snapshot|vm] [--local-port n] [--vm-port n] [--name n]
                                   [--dev-cmd "..."] [--skip-dev] [--skip-codex]
./setup.sh vm boot   <snapshotId>  [--local-port n] [--vm-port n] [--name n]
./setup.sh vm fork   <vmId>        [--local-port n] [--vm-port n] [--name n]
./setup.sh vm open   <vmId>        [--local-port n] [--vm-port n] [--name n]
./setup.sh vm dev    <snapshot|vm> [--local-port n] [--vm-port n] [--name n]
                                   [--dev-cmd "..."] [--skip-dev] [--skip-codex]
./setup.sh vm ssh    <vmId>        [--json] [--local-port n] [--vm-port n]
./setup.sh vm list   [--json]
./setup.sh vm delete <vmId>
```

Flags:

- `--local-port` Mac-side port that the SSH LocalForward binds. Default `17430`. Use a different port for each concurrent workspace so forks don't collide.
- `--vm-port` VM-side dev server port. Default `3000`.
- `--name` Workspace title in the cmux sidebar. Default `freestyle-<vmId prefix>` for boot/fork/open, `codex-<vmId prefix>` for new/dev.
- `--dev-cmd` (new/dev) override the command run in bottom-right. Default for `vm new` is the cmux clone+install+dev preset; default for `vm dev` is a python http.server smoke test.
- `--skip-dev` / `--skip-codex` (new/dev) leave the matching pane empty.
- `--no-open` (boot/fork only) skip cmux ssh, print creds only.
- `--json` (ssh/list) machine-readable output for scripting.

## Workflow A: boot a fresh VM with a minimal 2-pane layout

Use this only when the user explicitly wants the simple 2-pane layout (terminal + browser) without the cmux clone preset. For the default "start a new workspace" flow, use `vm new` (see top of this document).

```bash
./setup.sh secrets check                              # pre-flight
./setup.sh vm boot sh-17agfasevrc18c8f15nn --local-port 17430
```

This:

1. Calls `vms.create({ snapshot: { snapshotId } })` to boot the VM.
2. Polls until the VM reaches `running`.
3. Mints an ephemeral SSH identity + token (`identities.create()` -> `permissions.vms.grant({vmId})` -> `tokens.create()`).
4. Runs `cmux ssh <vmId>:<token>@vm-ssh.freestyle.sh --port 22 --no-focus --ssh-option 'LocalForward=<localPort> localhost:<vmPort>' ...` to open the workspace without stealing focus.
5. Adds a browser pane to the right pointed at `http://127.0.0.1:<localPort>/`.
6. Prints the resolved JSON: `vmId`, `workspaceRef`, ssh dest, identity/token ids, browser URL.

Once you have the workspace, start your dev server on the VM and the right pane shows it live. Smallest possible smoke test (run in the terminal on the VM, i.e., the left pane):

```bash
echo "<h1>cmux-freestyle demo</h1>" > /tmp/index.html
cd /tmp && nohup python3 -m http.server 3000 --bind 127.0.0.1 > /tmp/srv.log 2>&1 & disown
```

Then reload the browser pane in cmux and you see the page.

For a real dev session, run `codex` (or `claude`) in the left pane. The Freestyle snapshot already ships with `codex`, `claude`, `opencode`, `pi`, `bun`, and `node` on PATH. Each tool reads its credentials from the env. The easiest way to inject `OPENAI_API_KEY` without echoing it on screen is a single line through the existing SSH path:

```bash
printf 'export OPENAI_API_KEY=%q\n' "$OPENAI_API_KEY" | \
  ssh -p 22 <vmId>:<token>@vm-ssh.freestyle.sh \
    'cat > /root/.codex.env && chmod 600 /root/.codex.env'
```

Then in the left pane: `source /root/.codex.env && codex`.

## Workflow B: fork a running VM for parallel experimentation

```bash
./setup.sh vm fork <vmId> --local-port 17431
```

This:

1. Calls `vms.ref({vmId}).fork({})` (REST `POST /v1/vms/{vm_id}/fork`).
2. Picks the first fork from `result.forks` and polls until `running`.
3. Mints fresh SSH credentials for the fork (forks do not inherit identities/tokens).
4. Opens the fork in its own cmux workspace with the same layout. Use a **different** `--local-port` so the new workspace's LocalForward does not collide with the original.

Forks clone the source VM's memory and disk state at fork time. If the source had a dev server running, the fork already has it running too (same PID, same listening socket). The static content even reflects the source's hostname because env captures happened at fork time. This is the cool demo: a freeze-frame branch of your dev session.

The CLI does not surface fork directly (`freestyle vm --help` lists boot/list/ssh/exec/delete/build/snapshot but no fork). It only exists in the SDK and the REST API. `./setup.sh vm fork` is the wrapper.

## Workflow C: re-open an existing VM in a new workspace

If a workspace got closed or you want a second view onto the same VM:

```bash
./setup.sh vm open <vmId> --local-port 17432
```

Same flow as `boot`/`fork` minus the boot/fork step: mint creds, cmux ssh, add browser pane. Each `open` mints a fresh identity + token, so the old token in the closed workspace is now orphaned. Either revoke it through the Freestyle dashboard or accept the leak.

## SSH wire format

`./setup.sh vm ssh <vmId>` returns the raw building blocks if you want to wire cmux ssh by hand:

```text
ssh <vmId>:<token>@vm-ssh.freestyle.sh -p 22
```

cmux ssh accepts that destination verbatim:

```bash
cmux ssh '<vmId>:<token>@vm-ssh.freestyle.sh' \
  --port 22 \
  --name "freestyle-${VM_ID:0:6}" \
  --no-daemon-bootstrap \
  --ssh-option StrictHostKeyChecking=accept-new \
  --ssh-option UserKnownHostsFile=/dev/null \
  --ssh-option 'LocalForward=17430 localhost:3000' \
  --no-focus
```

`--no-daemon-bootstrap` is required for Freestyle: the vm-ssh gateway rejects scp on the exec channel, and without this flag cmux ssh stalls trying to upload `cmuxd-remote` and ends up in a reconnect loop (`exec request failed on channel 0`).

The LocalForward value must be quoted as one shell word (`'LocalForward=17430 localhost:3000'`), otherwise the space splits it into `--ssh-option LocalForward=17430` plus a stray `localhost:3000` positional.

## Workflow D: codex on left, browser on right (the full layout)

This is the demo flow the helper produces on every `boot|fork|open`:

1. `./setup.sh vm boot <snapshotId>` mints the workspace and the right-side browser pane.
2. In the left pane (already on the VM): start the dev server (`bun run dev`, `next dev`, `python3 -m http.server`, whatever).
3. In the left pane: run `codex` (or `claude` / `opencode` / `pi`).
4. The browser on the right shows your dev server. Reload as the agent edits files in the VM workspace; the change is visible immediately because both the dev server and the agent share the VM filesystem.

For a longer-running session, fork the VM (`./setup.sh vm fork <vmId> --local-port <free port>`) at the moment you want a branch and continue the agent in the fork while you keep the original on the side.

## Cleanup

Freestyle VMs accrue cost. When you are done:

```bash
./setup.sh vm list                  # see what's running
./setup.sh vm delete <vmId>         # one at a time; the workspace stays
                                    # in cmux but its SSH session drops
```

`./setup.sh vm delete` calls `vms.delete({vmId})`. The SSH identity + token minted by `open|boot|fork` are not auto-revoked; they become useless when the VM is deleted but the records linger. Delete them via the Freestyle dashboard (`Identities` and `Tokens`) when you want a clean slate.

## Rules and gotchas

- Always pre-flight with `./setup.sh secrets check`. Never prompt the user for a Freestyle API key in chat, never paste one yourself, never `export` one in commands you suggest. Hand off credential setup to `./setup.sh secrets set` and resume.
- **Prefer cmuxd-ws WebSocket attach over `cmux ssh` for freestyle VMs.** The russh gateway rejects exec channels (used by `scp cmuxd-remote`, `cmuxd-remote serve --stdio`, and any `bash -l -c '<cmd>'` you pass via `--`). With the WebSocket path you get the full cmuxd-remote feature set (proxy, port forwarding, file transfer); with cmux ssh you only get a shell. See "Transport: cmuxd-ws WebSocket, not ssh" above for the actual mint/install/attach steps.
- **`./setup.sh snapshot` must bake cmuxd-remote and `cmuxd-ws.service`.** `scripts/build-snapshot.ts` downloads the cmuxd-remote binary from the cmux GitHub release (`DAEMON_ASSET_NAME=cmuxd-remote-linux-amd64`, sha256-verified), drops it at `/usr/local/bin/cmuxd-remote`, writes `/etc/systemd/system/cmuxd-ws.service`, and creates the snapshot template with `ports: [{port:443, targetPort:7777}]`. Without all three of those, the WebSocket path falls over: `/healthz` returns the openresty placeholder HTML page, `wss://<domain>/terminal` never upgrades, and the workspace state flips from `connecting` straight to `disconnected`. If you see that, your snapshot was built by something else (the periodic `cmux-freestyle-YYYYMMDD-HHMMSS` snapshots in some accounts are NOT built by our script and DO NOT have cmuxd-ws baked) — rebuild it with `./setup.sh snapshot`.
- **`cmux-home/ink/src/cmux-ws.ts` runtime-installs cmuxd-remote + the systemd unit if missing.** This means cmux-home keeps working against stale or third-party snapshots, at the cost of ~3-5s extra cold start while curl + systemctl run. Long-term the snapshot should ship it preinstalled so the runtime install is a no-op.
- **If you really need `cmux ssh` against a Freestyle VM:** pass `--no-daemon-bootstrap` (the russh gateway rejects the daemon scp), `--ssh-option ControlMaster=no --ssh-option ControlPath=none` (or auto-reconnect deadlocks on the LocalForward port), `--no-focus` (don't steal focus), and `--ssh-option 'LocalForward=<localPort> localhost:<vmPort>'` for each port you want reachable. The `scripts/vm.ts` wrappers pass these for you. This path is legacy now that the WebSocket attach works; use it only when you specifically want a vanilla shell session and no daemon.
- Always pass `--no-focus` to `cmux ssh` (the helper does this for you). The user may be visually focused on another workspace.
- Pick a unique `--local-port` per concurrent workspace if you go down the `cmux ssh` path. The dev server inside each VM is on `:3000`, but the Mac-side forwarded ports must not collide. Reusing a port that another live cmux ssh holds will trip `ExitOnForwardFailure=yes` and kill the new connection. The WebSocket path doesn't have this problem — cmuxd-remote's RPC tunnels traffic through the existing wss connection.
- Freestyle snapshots are scoped to the building Freestyle account. A snapshot id from another account, including manaflow's, will not boot.
- Fork is SDK / REST only. `freestyle vm fork` does not exist in the CLI. The helper wraps `vm.fork()` (`POST /v1/vms/{vm_id}/fork`).
- The boot smoke checks already verify `cmuxd-remote`, `node`, `bun`, `codex`, `claude`, `opencode`, `pi`, `python3`, `openssl`; if your dev server fails to start, suspect your code, not the image.
- For port forwarding to fail loudly instead of silently when using the legacy `cmux ssh` path, the helper passes `ExitOnForwardFailure=yes` to ssh. If the cmux pane disconnects right after `cmux ssh`, suspect a clashing `--local-port`.
