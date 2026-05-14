---
name: cmux-freestyle
description: Drive cmux + Freestyle Cloud VMs end to end from the manaflow-ai/cmux-freestyle repo. Use when the user wants to boot a Freestyle VM from a snapshot, fork an existing VM to clone its running state, open a cmux workspace already SSH'd into a VM with a dev-server LocalForward, lay out codex on the left and a browser on the right pointed at the VM's localhost dev server, or set up a self-serve cmux + Freestyle workflow.
---

# cmux-freestyle

cmux-freestyle gives you everything you need to spin a fresh Freestyle Cloud VM and drive it from a cmux workspace as if it were local. The end state every flow targets:

- A cmux workspace SSH'd into a Freestyle VM, with an `ssh -L` LocalForward so the Mac browser can hit a dev server on the VM at `127.0.0.1:<localPort>`.
- Left pane: terminal on the VM (where you run `codex`, `claude`, or anything else).
- Right pane: cmux browser navigated to `http://127.0.0.1:<localPort>` so you see the dev server live as the agent edits.
- Optional: fork the running VM in place. Forks are memory + disk clones; the dev server keeps running on the fork. Open the fork in its own cmux workspace and the two run side by side.

The `./setup.sh vm` subcommand does all of this in one call.

## Env contract

- `FREESTYLE_API_KEY` is required. Either `export FREESTYLE_API_KEY=fk_...` or put it in `cmux-freestyle/.env` (the dispatcher auto-loads `.env`).
- A Freestyle snapshot id (for `vm boot`). Build one with `./setup.sh snapshot` or use any existing snapshot id from `./setup.sh vm list`.

## Subcommands

```bash
./setup.sh vm boot   <snapshotId> [--local-port n] [--vm-port n] [--name n]
./setup.sh vm fork   <vmId>        [--local-port n] [--vm-port n] [--name n]
./setup.sh vm open   <vmId>        [--local-port n] [--vm-port n] [--name n]
./setup.sh vm ssh    <vmId>        [--json] [--local-port n] [--vm-port n]
./setup.sh vm list   [--json]
./setup.sh vm delete <vmId>
```

Flags:

- `--local-port` Mac-side port that the SSH LocalForward binds. Default `17430`. Use a different port for each concurrent workspace so forks don't collide.
- `--vm-port` VM-side dev server port. Default `3000`.
- `--name` Workspace title in the cmux sidebar. Default `freestyle-<vmId prefix>`.
- `--no-open` (boot/fork only) skip cmux ssh, print creds only.
- `--json` (ssh/list) machine-readable output for scripting.

## Workflow A: boot a fresh VM and start a dev session

```bash
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
  --ssh-option StrictHostKeyChecking=accept-new \
  --ssh-option UserKnownHostsFile=/dev/null \
  --ssh-option 'LocalForward=17430 localhost:3000' \
  --no-focus
```

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

- Always pass `--no-focus` to `cmux ssh` (the helper does this for you). The user may be visually focused on another workspace.
- Pick a unique `--local-port` per concurrent workspace. The dev server inside each VM is on `:3000`, but the Mac-side forwarded ports must not collide.
- Freestyle snapshots are scoped to the building Freestyle account. A snapshot id from another account, including manaflow's, will not boot.
- Fork is SDK / REST only. `freestyle vm fork` does not exist in the CLI. The helper wraps `vm.fork()` (`POST /v1/vms/{vm_id}/fork`).
- The boot smoke checks already verify `cmuxd-remote`, `node`, `bun`, `codex`, `claude`, `opencode`, `pi`, `python3`, `openssl`; if your dev server fails to start, suspect your code, not the image.
- The dispatcher auto-loads `cmux-freestyle/.env`. Skip with `CMUX_FREESTYLE_SKIP_DOTENV=1`.
- For port forwarding to fail loudly instead of silently, the helper passes `ExitOnForwardFailure=yes` to ssh. If the cmux pane disconnects right after `cmux ssh`, suspect a clashing `--local-port`.
