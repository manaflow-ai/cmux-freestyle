---
name: cmux-freestyle
description: Drive cmux + Freestyle Cloud VMs end to end from the manaflow-ai/cmux-freestyle repo. Use when the user wants to boot a Freestyle VM from a snapshot, fork an existing VM to clone its running state, open a cmux workspace already SSH'd into a VM with a dev-server LocalForward, lay out codex on the left and a browser on the right pointed at the VM's localhost dev server, or set up a self-serve cmux + Freestyle workflow.
---

# cmux-freestyle

cmux-freestyle gives you everything you need to spin a fresh Freestyle Cloud VM and drive it from a cmux workspace as if it were local.

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

`vm new` boots a fresh VM from the configured snapshot, mints three independent SSH identities (one per long-lived pane to keep them independent), opens the cmux workspace with the LocalForward, waits for the dev URL, then reloads the browser. To override:

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
- **Always run `cmux ssh` yourself; never just print it for the user to copy-paste.** When the user says "give me the cmux ssh command", "open it", "run it", or anything in that family, you mint fresh creds (`./setup.sh vm boot|fork|open` or `vm ssh`) and execute `cmux ssh` from this repo's shell. Show the command in chat for reference, but the same turn must include the actual invocation. The user almost always wants the workspace opened, not a snippet to run by hand.
- **`cmux ssh` into Freestyle VMs requires `--no-daemon-bootstrap`.** `vm-ssh.freestyle.sh` is a forwarding-only SSH gateway; the default cmux ssh path tries to scp `cmuxd-remote` onto the host over the exec channel, the gateway rejects that, ssh exits 255 with `exec request failed on channel 0`, and cmux loops "reconnecting (attempt N/20)". The wrappers in `scripts/vm.ts` (`vm boot|fork|open|ssh|dev|new`) pass this flag for you. If you hand-roll a `cmux ssh` command for a Freestyle VM, you must add `--no-daemon-bootstrap` (this disables cmuxd-remote shell features, which the Freestyle image provides preinstalled anyway). Mint fresh creds and a unique local port for each new pane; do not reuse a token whose `cmux ssh` is still alive in another workspace.
- **`cmux ssh` into Freestyle VMs also requires `ControlMaster=no` and `ControlPath=none`.** Without these, cmux ssh defaults to `ControlMaster=auto` with a `/tmp/cmux-ssh-<uid>-%C` socket. On its own auto-reconnect, the new ssh child cannot bind the LocalForward port because the previous master is still holding it, so `ExitOnForwardFailure=yes` tears the reconnect down and the pane spams `mux_client_request_session: read from master failed: Broken pipe` and `bind [127.0.0.1]:<port>: Address already in use`. Symptoms look snapshot-specific (a heavier shell init can trigger the first disconnect that kicks off the loop), but the root cause is mux sharing, not the snapshot. The `scripts/vm.ts` wrappers pass these for you; hand-rolled `cmux ssh` commands must add `--ssh-option ControlMaster=no --ssh-option ControlPath=none`.
- Always pass `--no-focus` to `cmux ssh` (the helper does this for you). The user may be visually focused on another workspace.
- Pick a unique `--local-port` per concurrent workspace. The dev server inside each VM is on `:3000`, but the Mac-side forwarded ports must not collide. Reusing a port that another live cmux ssh holds will trip `ExitOnForwardFailure=yes` and kill the new connection.
- Freestyle snapshots are scoped to the building Freestyle account. A snapshot id from another account, including manaflow's, will not boot.
- Fork is SDK / REST only. `freestyle vm fork` does not exist in the CLI. The helper wraps `vm.fork()` (`POST /v1/vms/{vm_id}/fork`).
- The boot smoke checks already verify `cmuxd-remote`, `node`, `bun`, `codex`, `claude`, `opencode`, `pi`, `python3`, `openssl`; if your dev server fails to start, suspect your code, not the image.
- For port forwarding to fail loudly instead of silently, the helper passes `ExitOnForwardFailure=yes` to ssh. If the cmux pane disconnects right after `cmux ssh`, suspect a clashing `--local-port`.
