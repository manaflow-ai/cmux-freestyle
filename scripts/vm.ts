#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
// cmux-freestyle VM helper.
//
// Boots, forks, lists, deletes, or opens a Freestyle VM and (optionally)
// drops you into a cmux workspace that is already SSH'd into it with a
// LocalForward set up so a cmux browser pane can hit the VM's dev server.
//
// Subcommands:
//   vm new    [snapshotId]  [--local-port <n>] [--vm-port <n>] [--name <n>]
//                           [--dev-cmd "..."] [--skip-dev] [--skip-codex]
//                           [--openai-env <file>]
//                           default workspace: TL=codex, BL=empty ssh term,
//                           BR=clone manaflow-ai/cmux + bun install + bun dev,
//                           TR=browser auto-navigates to localhost:<vmPort>
//                           when dev server is up. If snapshotId is omitted,
//                           uses $FREESTYLE_SANDBOX_SNAPSHOT.
//   vm boot   <snapshotId> [--open] [--local-port <n>] [--vm-port <n>] [--name <n>]
//   vm fork   <vmId>        [--open] [--local-port <n>] [--vm-port <n>] [--name <n>]
//   vm open   <vmId>        [--local-port <n>] [--vm-port <n>] [--name <n>]
//   vm dev    <snapshot|vm> [--local-port <n>] [--vm-port <n>] [--name <n>]
//                           [--dev-cmd "..."] [--skip-dev] [--skip-codex]
//                           [--openai-env <file>]
//   vm ssh    <vmId>        [--json] [--local-port <n>] [--vm-port <n>]
//   vm list   [--json]
//   vm delete <vmId>
//
// Flags:
//   --open          After boot/fork, open the VM in a cmux workspace (default for boot/fork)
//   --no-open       Skip cmux ssh, just print creds
//   --local-port <n> Local port that LocalForward binds (default: 17430)
//   --vm-port <n>    VM-side dev server port (default: 3000)
//   --name <n>       Workspace title (default: freestyle-<vmId-prefix>)
//   --json           Machine-readable output (for ssh/list)
//
// Cleanup: VMs cost money. When you are done, run `./setup.sh vm delete <vmId>`.
// The identity + token minted for each `open` call are not automatically
// revoked here. Use the Freestyle dashboard or SDK to prune them if needed.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as net from "node:net";
import { Freestyle } from "freestyle";

const apiKey = process.env.FREESTYLE_API_KEY;
if (!apiKey) {
  console.error("error: FREESTYLE_API_KEY is required (export it or put it in .env)");
  process.exit(1);
}

const fs = new Freestyle({ apiKey });

type Args = {
  positional: string[];
  open?: boolean;
  noOpen?: boolean;
  localPort: number;
  vmPort: number;
  name?: string;
  json?: boolean;
  devCmd?: string;
  skipDev?: boolean;
  skipCodex?: boolean;
  openaiEnv?: string;
  devReadyTimeoutMs: number;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    positional: [],
    localPort: 17430,
    vmPort: 3000,
    devReadyTimeoutMs: 240_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--open") out.open = true;
    else if (a === "--no-open") out.noOpen = true;
    else if (a === "--json") out.json = true;
    else if (a === "--local-port") out.localPort = Number(argv[++i]);
    else if (a === "--vm-port") out.vmPort = Number(argv[++i]);
    else if (a === "--name") out.name = argv[++i];
    else if (a === "--dev-cmd") out.devCmd = argv[++i];
    else if (a === "--skip-dev") out.skipDev = true;
    else if (a === "--skip-codex") out.skipCodex = true;
    else if (a === "--openai-env") out.openaiEnv = argv[++i];
    else if (a === "--dev-ready-timeout-ms") out.devReadyTimeoutMs = Number(argv[++i]);
    else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function printUsage(): void {
  process.stdout.write(`\
cmux-freestyle vm helper

  vm new    [snapshot|vm] [--local-port n] [--vm-port n] [--name n]
                          [--dev-cmd "..."] [--skip-dev] [--skip-codex]
                          [--openai-env <file>] [--dev-ready-timeout-ms n]
                          default workspace: TL codex, BL empty term,
                          BR clone manaflow-ai/cmux + bun install + bun dev,
                          TR browser. Uses $FREESTYLE_SANDBOX_SNAPSHOT if no id.
  vm boot   <snapshotId> [--open|--no-open] [--local-port n] [--vm-port n] [--name n]
  vm fork   <vmId>        [--open|--no-open] [--local-port n] [--vm-port n] [--name n]
  vm open   <vmId>        [--local-port n] [--vm-port n] [--name n]
  vm dev    <snapshot|vm> [--local-port n] [--vm-port n] [--name n]
                          [--dev-cmd "..."] [--skip-dev] [--skip-codex]
                          [--openai-env <file>] [--dev-ready-timeout-ms n]
  vm ssh    <vmId>        [--json] [--local-port n] [--vm-port n]
  vm list   [--json]
  vm delete <vmId>

env: FREESTYLE_API_KEY        (required)
     FREESTYLE_SANDBOX_SNAPSHOT (default snapshot for 'vm new')
     OPENAI_API_KEY           (vm new/dev: stamps codex auth.json; otherwise codex prompts)
`);
}

async function pollUntilRunning(vmId: string, attempts = 20, intervalMs = 1500): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const list = await fs.vms.list();
    const found = list.vms.find((v) => v.id === vmId);
    const state = found?.state ?? "unknown";
    if (state === "running") return state;
    process.stderr.write(`  [${i + 1}/${attempts}] state=${state}\n`);
    if (state === "lost" || state === "stopped") return state;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return "timeout";
}

async function mintSshCreds(vmId: string): Promise<{
  identityId: string;
  tokenId: string;
  token: string;
  sshDestination: string;
  sshPort: number;
}> {
  const { identity, identityId } = await fs.identities.create();
  await identity.permissions.vms.grant({ vmId });
  const { token, tokenId } = await identity.tokens.create();
  return {
    identityId,
    tokenId,
    token,
    sshDestination: `${vmId}:${token}@vm-ssh.freestyle.sh`,
    sshPort: 22,
  };
}

function shortId(vmId: string, n = 6): string {
  return vmId.slice(0, n);
}

function runCmuxSsh(args: {
  sshDestination: string;
  sshPort: number;
  name: string;
  localPort: number;
  vmPort: number;
}): { workspaceRef: string | undefined; raw: string } {
  // ControlMaster is explicitly disabled. cmux ssh defaults to
  // `ControlMaster=auto` with `ControlPath=/tmp/cmux-ssh-<uid>-%C`, which:
  //   1. leaves a long-lived master socket around even after the pane closes
  //   2. on cmux's auto-reconnect, the new ssh child can't bind the
  //      LocalForward port because the previous master is still holding it,
  //      so ExitOnForwardFailure=yes tears the reconnect down ("Address
  //      already in use"), and we loop forever spamming the pane with
  //      `mux_client_request_session: read from master failed: Broken pipe`
  //   3. masking conflicts with one-shot ssh sessions in the other panes
  // We mint fresh creds per pane and don't need session sharing here.
  const cli = [
    "ssh",
    args.sshDestination,
    "--port",
    String(args.sshPort),
    "--name",
    args.name,
    "--no-daemon-bootstrap",
    "--ssh-option",
    "ControlMaster=no",
    "--ssh-option",
    "ControlPath=none",
    "--ssh-option",
    "StrictHostKeyChecking=accept-new",
    "--ssh-option",
    "UserKnownHostsFile=/dev/null",
    "--ssh-option",
    "LogLevel=ERROR",
    "--ssh-option",
    "ServerAliveInterval=30",
    "--ssh-option",
    `LocalForward=${args.localPort} localhost:${args.vmPort}`,
    "--ssh-option",
    "ExitOnForwardFailure=yes",
    "--no-focus",
  ];
  const result = spawnSync("cmux", cli, { stdio: ["ignore", "pipe", "inherit"] });
  const raw = result.stdout?.toString() ?? "";
  const match = raw.match(/workspace=(workspace:\d+)/);
  return { workspaceRef: match?.[1], raw };
}

function addBrowserPane(workspaceRef: string, url: string): void {
  spawnSync(
    "cmux",
    ["new-pane", "--workspace", workspaceRef, "--type", "browser", "--direction", "right", "--url", url, "--focus", "false"],
    { stdio: "inherit" }
  );
}

async function cmdBoot(args: Args): Promise<void> {
  const snapshotId = args.positional[1];
  if (!snapshotId) throw new Error("usage: vm boot <snapshotId>");
  process.stderr.write(`booting from ${snapshotId}...\n`);
  const created = await fs.vms.create({ snapshotId });
  const vmId = created.vmId;
  process.stderr.write(`  vmId=${vmId}\n`);
  process.stderr.write("waiting for running state...\n");
  const state = await pollUntilRunning(vmId);
  if (state !== "running") {
    throw new Error(`VM ${vmId} did not reach running state (state=${state})`);
  }
  if (args.noOpen) {
    console.log(JSON.stringify({ vmId, snapshotId, state }, null, 2));
    return;
  }
  await openInCmux(vmId, args);
}

async function cmdFork(args: Args): Promise<void> {
  const sourceVmId = args.positional[1];
  if (!sourceVmId) throw new Error("usage: vm fork <vmId>");
  process.stderr.write(`forking ${sourceVmId}...\n`);
  const vm = fs.vms.ref({ vmId: sourceVmId });
  const result = await vm.fork({});
  const forkVmId = result.forks[0]?.vmId;
  if (!forkVmId) throw new Error("fork returned no vmId");
  process.stderr.write(`  forkVmId=${forkVmId}\n`);
  const state = await pollUntilRunning(forkVmId);
  if (state !== "running") {
    throw new Error(`fork ${forkVmId} did not reach running state (state=${state})`);
  }
  if (args.noOpen) {
    console.log(JSON.stringify({ sourceVmId, forkVmId, state }, null, 2));
    return;
  }
  await openInCmux(forkVmId, args);
}

async function cmdOpen(args: Args): Promise<void> {
  const vmId = args.positional[1];
  if (!vmId) throw new Error("usage: vm open <vmId>");
  await openInCmux(vmId, args);
}

async function openInCmux(vmId: string, args: Args): Promise<void> {
  process.stderr.write(`minting ssh creds for ${vmId}...\n`);
  const creds = await mintSshCreds(vmId);
  const name = args.name ?? `freestyle-${shortId(vmId)}`;
  process.stderr.write(`opening cmux workspace ${name} (LocalForward ${args.localPort} -> :${args.vmPort})\n`);
  const { workspaceRef, raw } = runCmuxSsh({
    sshDestination: creds.sshDestination,
    sshPort: creds.sshPort,
    name,
    localPort: args.localPort,
    vmPort: args.vmPort,
  });
  if (!workspaceRef) {
    process.stderr.write(`cmux ssh output: ${raw}\n`);
    throw new Error("could not parse workspace ref from cmux ssh output");
  }
  process.stderr.write(`  workspace=${workspaceRef}\n`);
  const browserUrl = `http://127.0.0.1:${args.localPort}/`;
  process.stderr.write(`adding browser pane -> ${browserUrl}\n`);
  addBrowserPane(workspaceRef, browserUrl);
  console.log(
    JSON.stringify(
      {
        vmId,
        workspaceRef,
        name,
        localPort: args.localPort,
        vmPort: args.vmPort,
        sshDestination: creds.sshDestination,
        sshPort: creds.sshPort,
        identityId: creds.identityId,
        tokenId: creds.tokenId,
        browserUrl,
      },
      null,
      2
    )
  );
}

function isSnapshotId(id: string): boolean {
  return id.startsWith("sh-");
}

function execSshCapture(
  creds: { sshDestination: string; sshPort: number },
  remote: string,
  input?: string
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(
    "ssh",
    [
      "-p",
      String(creds.sshPort),
      "-F",
      "/dev/null",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      creds.sshDestination,
      remote,
    ],
    { input, encoding: "utf8" }
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

async function waitForLocalListen(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ port, host: "127.0.0.1" });
      sock.setTimeout(1000);
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("timeout", () => {
        sock.destroy();
        resolve(false);
      });
      sock.once("error", () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function parseSurfacesFromTree(treeOut: string): { terminalSurface: string; browserSurface: string } {
  const terminalMatch = treeOut.match(/surface (surface:\d+) \[terminal\]/);
  const browserMatch = treeOut.match(/surface (surface:\d+) \[browser\]/);
  if (!terminalMatch || !browserMatch) {
    throw new Error(`could not parse terminal/browser surfaces from cmux tree:\n${treeOut}`);
  }
  return { terminalSurface: terminalMatch[1]!, browserSurface: browserMatch[1]! };
}

function cmuxTree(workspaceRef: string): string {
  const result = spawnSync("cmux", ["tree", "--workspace", workspaceRef], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return result.stdout?.toString() ?? "";
}

function cmuxSplitDown(workspaceRef: string, surfaceRef: string): string {
  const result = spawnSync(
    "cmux",
    ["new-split", "down", "--workspace", workspaceRef, "--surface", surfaceRef, "--focus", "false"],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  const raw = result.stdout?.toString() ?? "";
  const m = raw.match(/OK (surface:\d+)/);
  if (!m) throw new Error(`new-split did not return surface id: ${raw}`);
  return m[1]!;
}

function cmuxSendText(workspaceRef: string, surfaceRef: string, text: string): void {
  spawnSync(
    "cmux",
    ["send", "--workspace", workspaceRef, "--surface", surfaceRef, "--", text],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
}

function cmuxBrowserReload(surfaceRef: string): void {
  spawnSync("cmux", ["browser", "--surface", surfaceRef, "reload"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function cmuxReadScreen(workspaceRef: string, surfaceRef: string, lines = 6): string {
  const result = spawnSync(
    "cmux",
    ["read-screen", "--workspace", workspaceRef, "--surface", surfaceRef, "--lines", String(lines)],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  return result.stdout?.toString() ?? "";
}

// Heuristic: an interactive shell prompt that lands on its own line. Matches
// `$ `, `# `, `% `, `> ` at the end (optionally with trailing whitespace) and
// avoids matching cmux's own retry messages.
const SHELL_PROMPT_REGEX = /(?:^|\n)[^\n]*[#$%>] *$/m;

async function waitForPrompt(
  workspaceRef: string,
  surfaceRef: string,
  timeoutMs: number,
  pollMs = 500
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const screen = cmuxReadScreen(workspaceRef, surfaceRef, 4).trimEnd();
    if (screen && SHELL_PROMPT_REGEX.test(screen) && !/reconnecting \(attempt/.test(screen)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  process.stderr.write(
    `warning: pane ${surfaceRef} did not show a shell prompt within ${timeoutMs}ms; sending text anyway\n`
  );
  return false;
}

async function waitForUrl(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status >= 200 && res.status < 500) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function resolveOpenaiKey(args: Args): string | undefined {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const path = args.openaiEnv;
  if (!path) return undefined;
  try {
    const text = readFileSync(path, "utf8");
    const m = text.match(/^OPENAI_API_KEY=(.+)$/m);
    if (m) return m[1]!.trim().replace(/^['"]|['"]$/g, "");
  } catch (e) {
    process.stderr.write(`warning: could not read --openai-env ${path}: ${(e as Error).message}\n`);
  }
  return undefined;
}

function stampCodexAuth(
  creds: { sshDestination: string; sshPort: number },
  openaiKey: string
): void {
  process.stderr.write("stamping codex auth.json + config.toml on VM...\n");
  const remote =
    "mkdir -p /root/.codex && " +
    "cat > /root/.codex/auth.json && chmod 600 /root/.codex/auth.json && " +
    `printf '%s\\n' '[projects."/root"]' 'trust_level = \"trusted\"' > /root/.codex/config.toml`;
  const authJson = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: openaiKey }) + "\n";
  const result = execSshCapture(creds, remote, authJson);
  if (result.code !== 0) {
    throw new Error(`failed to stamp codex auth (exit ${result.code}): ${result.stderr || result.stdout}`);
  }
}

// "Start a new workspace" preset. The end state:
//   top-left:     codex running, ready for the user to type
//   bottom-left:  empty terminal on the VM, ready for ad-hoc commands
//   bottom-right: clones manaflow-ai/cmux (depth 1), bun install, bun dev
//   top-right:    browser that auto-navigates to http://127.0.0.1:<localPort>
//                 once the dev server on the VM's <vmPort> responds
//
// All of this is just `vm dev` with a baked-in --dev-cmd and a default snapshot
// from $FREESTYLE_SANDBOX_SNAPSHOT, kept as its own subcommand so the SKILL has
// a single, stable entrypoint for "start a new workspace".
const CMUX_CLONE_DEV_CMD =
  "git clone --depth 1 https://github.com/manaflow-ai/cmux && cd cmux && bun install && bun dev";

async function cmdNew(args: Args): Promise<void> {
  let id = args.positional[1];
  if (!id) {
    id = process.env.FREESTYLE_SANDBOX_SNAPSHOT?.trim();
    if (!id) {
      throw new Error(
        "usage: vm new [snapshotId|vmId]\n" +
          "  (or set FREESTYLE_SANDBOX_SNAPSHOT for a default snapshot)"
      );
    }
    process.stderr.write(`using default snapshot from FREESTYLE_SANDBOX_SNAPSHOT=${id}\n`);
    args.positional[1] = id;
  }
  if (!args.devCmd) {
    args.devCmd = CMUX_CLONE_DEV_CMD;
  }
  await cmdDev(args);
}

async function cmdDev(args: Args): Promise<void> {
  const id = args.positional[1];
  if (!id) throw new Error("usage: vm dev <snapshotId|vmId>");

  let vmId: string;
  let snapshotId: string | undefined;
  if (isSnapshotId(id)) {
    snapshotId = id;
    process.stderr.write(`booting from ${snapshotId}...\n`);
    const created = await fs.vms.create({ snapshotId });
    vmId = created.vmId;
    process.stderr.write(`  vmId=${vmId}\n`);
    process.stderr.write("waiting for running state...\n");
    const state = await pollUntilRunning(vmId);
    if (state !== "running") throw new Error(`VM ${vmId} did not reach running state (state=${state})`);
  } else {
    vmId = id;
    process.stderr.write(`attaching to existing VM ${vmId}...\n`);
  }

  const openaiKey = args.skipCodex ? undefined : resolveOpenaiKey(args);
  if (openaiKey) {
    const stampCreds = await mintSshCreds(vmId);
    stampCodexAuth(stampCreds, openaiKey);
  } else if (!args.skipCodex) {
    process.stderr.write(
      "warning: OPENAI_API_KEY not found (env or --openai-env); codex will prompt for auth on first run\n"
    );
  }

  // One set of creds for the whole workspace. cmux ssh marks the workspace as
  // remote-SSH, so every pane created via split inherits this destination and
  // opens its own independent ssh connection using the same token (the
  // Freestyle gateway is fine with multiple concurrent sessions per token).
  // Do NOT mint per-pane creds and then `ssh vm-ssh.freestyle.sh` inside a
  // split pane: that re-enters the gateway from the VM itself, which the VM
  // cannot reach and which crashes the parent ssh.
  const creds = await mintSshCreds(vmId);

  const name = args.name ?? `codex-${shortId(vmId)}`;
  process.stderr.write(`opening cmux workspace ${name} (LocalForward ${args.localPort} -> :${args.vmPort})\n`);
  const { workspaceRef, raw } = runCmuxSsh({
    sshDestination: creds.sshDestination,
    sshPort: creds.sshPort,
    name,
    localPort: args.localPort,
    vmPort: args.vmPort,
  });
  if (!workspaceRef) {
    process.stderr.write(`cmux ssh output: ${raw}\n`);
    throw new Error("could not parse workspace ref from cmux ssh output");
  }

  process.stderr.write(`waiting for cmux ssh LocalForward on 127.0.0.1:${args.localPort} ...\n`);
  const forwardUp = await waitForLocalListen(args.localPort, 30_000);
  if (!forwardUp) {
    process.stderr.write(
      `warning: LocalForward did not bind within 30s; continuing anyway (cmux ssh may not be ready)\n`
    );
  }

  const browserUrl = `http://127.0.0.1:${args.localPort}/`;
  process.stderr.write(`adding browser pane -> ${browserUrl}\n`);
  addBrowserPane(workspaceRef, browserUrl);

  const tree = cmuxTree(workspaceRef);
  const { terminalSurface, browserSurface } = parseSurfacesFromTree(tree);
  process.stderr.write(`top-left terminal=${terminalSurface}, top-right browser=${browserSurface}\n`);

  process.stderr.write("splitting top-left + top-right downward (2x2 layout)...\n");
  const bottomLeft = cmuxSplitDown(workspaceRef, terminalSurface);
  const bottomRight = cmuxSplitDown(workspaceRef, browserSurface);
  process.stderr.write(`bottom-left=${bottomLeft}, bottom-right=${bottomRight}\n`);

  // Wait for each split's cmux ssh to land on a shell prompt before typing
  // into it. Otherwise the dev-cmd / codex keystrokes can land while the pane
  // is still in `[cmux] ssh exited with status 255; reconnecting` retries and
  // get lost.
  process.stderr.write("waiting for bottom-right ssh prompt...\n");
  await waitForPrompt(workspaceRef, bottomRight, 60_000);
  process.stderr.write("waiting for top-left ssh prompt...\n");
  await waitForPrompt(workspaceRef, terminalSurface, 60_000);

  const devCmd = args.devCmd ?? `cd /tmp && python3 -m http.server ${args.vmPort} --bind 127.0.0.1`;
  if (!args.skipDev) {
    process.stderr.write(`starting dev server in bottom-right: ${devCmd}\n`);
    cmuxSendText(workspaceRef, bottomRight, `${devCmd}\n`);
    process.stderr.write(`waiting for ${browserUrl} ...\n`);
    const ready = await waitForUrl(browserUrl, args.devReadyTimeoutMs);
    if (ready) {
      process.stderr.write(`dev server is up; reloading browser pane\n`);
      cmuxBrowserReload(browserSurface);
    } else {
      process.stderr.write(
        `dev server did not respond within ${args.devReadyTimeoutMs}ms; check bottom-right pane for errors\n`
      );
    }
  }

  if (!args.skipCodex) {
    process.stderr.write("launching codex in top-left\n");
    cmuxSendText(workspaceRef, terminalSurface, "codex\n");
  }

  console.log(
    JSON.stringify(
      {
        vmId,
        snapshotId: snapshotId ?? null,
        workspaceRef,
        name,
        localPort: args.localPort,
        vmPort: args.vmPort,
        browserUrl,
        terminalSurface,
        browserSurface,
        bottomLeftSurface: bottomLeft,
        bottomRightSurface: bottomRight,
        sshDestination: creds.sshDestination,
        sshPort: creds.sshPort,
        devCmd: args.skipDev ? null : devCmd,
        codex: !args.skipCodex,
      },
      null,
      2
    )
  );
}

async function cmdSsh(args: Args): Promise<void> {
  const vmId = args.positional[1];
  if (!vmId) throw new Error("usage: vm ssh <vmId>");
  const creds = await mintSshCreds(vmId);
  const shQuote = (s: string): string => (/[\s"'$`\\]/.test(s) ? `'${s.replaceAll("'", "'\\''")}'` : s);
  const cmuxSsh = [
    "cmux",
    "ssh",
    creds.sshDestination,
    "--port",
    String(creds.sshPort),
    "--name",
    args.name ?? `freestyle-${shortId(vmId)}`,
    "--no-daemon-bootstrap",
    "--ssh-option",
    "ControlMaster=no",
    "--ssh-option",
    "ControlPath=none",
    "--ssh-option",
    "StrictHostKeyChecking=accept-new",
    "--ssh-option",
    "UserKnownHostsFile=/dev/null",
    "--ssh-option",
    `LocalForward=${args.localPort} localhost:${args.vmPort}`,
    "--no-focus",
  ]
    .map(shQuote)
    .join(" ");
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          vmId,
          identityId: creds.identityId,
          tokenId: creds.tokenId,
          sshDestination: creds.sshDestination,
          sshPort: creds.sshPort,
          rawSshCommand: `ssh ${creds.sshDestination} -p ${creds.sshPort}`,
          cmuxSshCommand: cmuxSsh,
        },
        null,
        2
      )
    );
  } else {
    process.stdout.write(`# raw ssh\nssh ${creds.sshDestination} -p ${creds.sshPort}\n\n# cmux workspace\n${cmuxSsh}\n`);
  }
}

async function cmdList(args: Args): Promise<void> {
  const list = await fs.vms.list();
  if (args.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  for (const v of list.vms) {
    process.stdout.write(
      `${v.id}  state=${v.state}  snapshot=${(v as { snapshotId?: string | null }).snapshotId ?? "-"}  created=${v.createdAt ?? "-"}\n`
    );
  }
}

async function cmdDelete(args: Args): Promise<void> {
  const vmId = args.positional[1];
  if (!vmId) throw new Error("usage: vm delete <vmId>");
  await fs.vms.delete({ vmId });
  process.stdout.write(`deleted ${vmId}\n`);
}

const args = parseArgs(process.argv.slice(2));
const sub = args.positional[0];
try {
  switch (sub) {
    case "new":
      await cmdNew(args);
      break;
    case "boot":
      await cmdBoot(args);
      break;
    case "fork":
      await cmdFork(args);
      break;
    case "open":
      await cmdOpen(args);
      break;
    case "dev":
      await cmdDev(args);
      break;
    case "ssh":
      await cmdSsh(args);
      break;
    case "list":
      await cmdList(args);
      break;
    case "delete":
      await cmdDelete(args);
      break;
    default:
      printUsage();
      if (sub) {
        console.error(`\nunknown subcommand: ${sub}`);
        process.exit(2);
      }
  }
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
}
