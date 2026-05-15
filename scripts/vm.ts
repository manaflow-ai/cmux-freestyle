#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
// cmux-freestyle VM helper.
//
// Boots, forks, lists, deletes, or opens a Freestyle VM and (optionally)
// drops you into a cmux workspace that is already SSH'd into it with a
// LocalForward set up so a cmux browser pane can hit the VM's dev server.
//
// Subcommands:
//   vm boot   <snapshotId> [--open] [--local-port <n>] [--vm-port <n>] [--name <n>]
//   vm fork   <vmId>        [--open] [--local-port <n>] [--vm-port <n>] [--name <n>]
//   vm open   <vmId>        [--local-port <n>] [--vm-port <n>] [--name <n>]
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
};

function parseArgs(argv: string[]): Args {
  const out: Args = { positional: [], localPort: 17430, vmPort: 3000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--open") out.open = true;
    else if (a === "--no-open") out.noOpen = true;
    else if (a === "--json") out.json = true;
    else if (a === "--local-port") out.localPort = Number(argv[++i]);
    else if (a === "--vm-port") out.vmPort = Number(argv[++i]);
    else if (a === "--name") out.name = argv[++i];
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

  vm boot   <snapshotId> [--open|--no-open] [--local-port n] [--vm-port n] [--name n]
  vm fork   <vmId>        [--open|--no-open] [--local-port n] [--vm-port n] [--name n]
  vm open   <vmId>        [--local-port n] [--vm-port n] [--name n]
  vm ssh    <vmId>        [--json] [--local-port n] [--vm-port n]
  vm list   [--json]
  vm delete <vmId>

env: FREESTYLE_API_KEY (required)
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
  const cli = [
    "ssh",
    args.sshDestination,
    "--port",
    String(args.sshPort),
    "--name",
    args.name,
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
    case "boot":
      await cmdBoot(args);
      break;
    case "fork":
      await cmdFork(args);
      break;
    case "open":
      await cmdOpen(args);
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
