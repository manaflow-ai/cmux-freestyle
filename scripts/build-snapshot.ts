#!/usr/bin/env -S npx tsx
import { Freestyle } from "freestyle";

const STRICT_SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const UTF8_LOCALE = "C.UTF-8";
const PRIMARY_LINUX_USER = "cmux";
const CLOUD_SHELL_PACKAGES = [
  "bash",
  "ca-certificates",
  "curl",
  "dirmngr",
  "git",
  "gnupg",
  "gpg-agent",
  "libssl3t64",
  "locales",
  "openssl",
  "python3",
  "sudo",
  "unzip",
  "xz-utils",
];

const SNAPSHOT_CREATE_TIMEOUT_MS = positiveIntFromEnv(
  "CMUX_FREESTYLE_SNAPSHOT_CREATE_TIMEOUT_MS",
  20 * 60 * 1000,
);
const SNAPSHOT_RECOVERY_TIMEOUT_MS = positiveIntFromEnv(
  "CMUX_FREESTYLE_SNAPSHOT_RECOVERY_TIMEOUT_MS",
  10 * 60 * 1000,
);
const SNAPSHOT_RECOVERY_POLL_INTERVAL_MS = positiveIntFromEnv(
  "CMUX_FREESTYLE_SNAPSHOT_RECOVERY_POLL_INTERVAL_MS",
  5_000,
);
const SNAPSHOT_RECOVERY_CLOCK_SKEW_MS = positiveIntFromEnv(
  "CMUX_FREESTYLE_SNAPSHOT_RECOVERY_CLOCK_SKEW_MS",
  2 * 60 * 1000,
);

type CloudAgentTool = {
  readonly name: string;
  readonly flag: string;
  readonly envVar: string;
  readonly defaultSpec: string;
  readonly binaries: ReadonlyArray<string>;
};

const CLOUD_AGENT_TOOLS: ReadonlyArray<CloudAgentTool> = [
  {
    name: "claude",
    flag: "--claude-spec",
    envVar: "CMUX_CLOUD_IMAGE_CLAUDE_CODE_NPM_SPEC",
    defaultSpec: "@anthropic-ai/claude-code@2.1.137",
    binaries: ["claude"],
  },
  {
    name: "opencode",
    flag: "--opencode-spec",
    envVar: "CMUX_CLOUD_IMAGE_OPENCODE_NPM_SPEC",
    defaultSpec: "opencode-ai@1.14.41",
    binaries: ["opencode"],
  },
  {
    name: "codex",
    flag: "--codex-spec",
    envVar: "CMUX_CLOUD_IMAGE_CODEX_NPM_SPEC",
    defaultSpec: "@openai/codex@0.130.0",
    binaries: ["codex"],
  },
  {
    name: "pi",
    flag: "--pi-spec",
    envVar: "CMUX_CLOUD_IMAGE_PI_NPM_SPEC",
    defaultSpec: "@earendil-works/pi-coding-agent@0.74.0",
    binaries: ["pi"],
  },
];

type Args = {
  readonly name: string;
  readonly releaseTag: string | null;
  readonly nodeMajor: string;
  readonly bunVersion: string;
  readonly tools: ReadonlyArray<ResolvedAgentTool>;
  readonly skipCache: boolean;
  readonly json: boolean;
};

type ResolvedAgentTool = CloudAgentTool & {
  readonly packageSpec: string;
  readonly resolvedVersion: string;
};

type DaemonRelease = {
  readonly tag: string;
  readonly downloadURL: string;
  readonly sha256: string;
  readonly checksumsURL: string;
  readonly releaseURL: string;
};

const REPO_OWNER = "manaflow-ai";
const REPO_NAME = "cmux";
const DAEMON_ASSET_NAME = "cmuxd-remote-linux-amd64";
const CHECKSUMS_ASSET_NAME = "cmuxd-remote-checksums.txt";

await main();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  requireEnv("FREESTYLE_API_KEY");

  log(args, `Resolving cmuxd-remote release (${args.releaseTag ?? "latest stable"})`);
  const release = await resolveDaemonRelease(args.releaseTag);
  log(
    args,
    `Using cmuxd-remote ${release.tag} (sha256=${release.sha256.slice(0, 12)}…) from ${release.releaseURL}`,
  );

  const dockerfile = freestyleBaseDockerfileContent({
    daemonURL: release.downloadURL,
    daemonSha256: release.sha256,
    nodeMajor: args.nodeMajor,
    bunVersion: args.bunVersion,
    tools: args.tools,
  });

  const fs = new Freestyle({ fetch: fetchWithTimeout(SNAPSHOT_CREATE_TIMEOUT_MS) });
  const createStartedAt = new Date();
  log(args, `Submitting snapshot ${args.name} to Freestyle`);
  let result: unknown;
  try {
    result = await fs.vms.snapshots.create({
      name: args.name,
      template: {
        baseImage: { dockerfileContent: dockerfile },
        ports: [{ port: 443, targetPort: 7777 }],
        discriminator: args.name,
        skipCache: args.skipCache,
      },
    });
  } catch (err) {
    log(args, `Snapshot create errored, attempting recovery: ${errorSummary(err)}`);
    const recovered = await waitForFreestyleSnapshotByName(
      fs,
      args.name,
      recoveryWindowStart(createStartedAt),
      SNAPSHOT_RECOVERY_TIMEOUT_MS,
    );
    if (!recovered) throw err;
    result = {
      snapshotId: recovered.snapshotId,
      recoveredAfterCreateError: errorSummary(err),
    };
  }

  const snapshotId = extractSnapshotId(result);
  if (!snapshotId) {
    const keys =
      result && typeof result === "object"
        ? Object.keys(result as Record<string, unknown>).sort().join(", ")
        : typeof result;
    throw new Error(`Freestyle snapshot create did not return a snapshot id; result keys: ${keys}`);
  }

  const summary = {
    snapshotId,
    name: args.name,
    cmuxReleaseTag: release.tag,
    cmuxRemoteDownloadURL: release.downloadURL,
    cmuxRemoteSha256: release.sha256,
    cmuxReleaseURL: release.releaseURL,
    nodeMajor: args.nodeMajor,
    bunVersion: args.bunVersion,
    agentTools: args.tools.map((tool) => ({
      name: tool.name,
      packageSpec: tool.packageSpec,
      resolvedVersion: tool.resolvedVersion,
    })),
    builtAt: new Date().toISOString(),
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  process.stdout.write("\nSnapshot ready.\n\n");
  process.stdout.write(`FREESTYLE_SANDBOX_SNAPSHOT=${snapshotId}\n\n`);
  process.stdout.write(
    `Source release : ${release.releaseURL}\n` +
      `Daemon SHA-256 : ${release.sha256}\n` +
      `Snapshot name  : ${args.name}\n` +
      `Node major     : ${args.nodeMajor}\n` +
      `Bun version    : ${args.bunVersion}\n`,
  );
  if (args.tools.length > 0) {
    process.stdout.write(
      `Agent tools    : ${args.tools.map((t) => `${t.name}=${t.resolvedVersion}`).join(", ")}\n`,
    );
  } else {
    process.stdout.write("Agent tools    : (none, all opted out)\n");
  }
  process.stdout.write(
    "\nBoot a VM from it:\n  npx -y freestyle vm create --snapshot " +
      `${snapshotId} --ssh\n`,
  );
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    return value;
  };
  const has = (name: string): boolean => argv.includes(name);

  const name =
    flag("--name") ?? process.env.CMUX_FREESTYLE_SNAPSHOT_NAME?.trim() ?? defaultSnapshotName();
  const releaseTag = (flag("--release") ?? process.env.CMUX_RELEASE_TAG ?? "").trim() || null;
  const nodeMajorRaw =
    (flag("--node-major") ?? process.env.CMUX_CLOUD_IMAGE_NODE_MAJOR ?? "22").trim();
  if (!/^[1-9]\d*$/.test(nodeMajorRaw)) {
    throw new Error(`--node-major must be a positive integer; got ${nodeMajorRaw}`);
  }
  const nodeMajor = nodeMajorRaw;
  const bunVersion = semverOrFallback(
    flag("--bun-version") ?? process.env.CMUX_CLOUD_IMAGE_BUN_VERSION,
    "1.3.13",
  );

  const tools = CLOUD_AGENT_TOOLS.flatMap<ResolvedAgentTool>((tool) => {
    const raw = (flag(tool.flag) ?? process.env[tool.envVar] ?? "").trim();
    if (raw && isDisabledValue(raw)) return [];
    const packageSpec = raw || tool.defaultSpec;
    const resolvedVersion = pinnedNpmPackageVersion(packageSpec);
    if (!resolvedVersion) {
      throw new Error(
        `${tool.flag}/${tool.envVar} must be an exact npm version spec (for example ${tool.defaultSpec}); got ${packageSpec}`,
      );
    }
    return [{ ...tool, packageSpec, resolvedVersion }];
  });

  const skipCache =
    has("--skip-cache") ||
    boolFromEnv("CMUX_FREESTYLE_SKIP_CACHE");
  const json = has("--json") || boolFromEnv("CMUX_FREESTYLE_JSON");

  return { name, releaseTag, nodeMajor, bunVersion, tools, skipCache, json };
}

function defaultSnapshotName(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  return `cmux-freestyle-${stamp}`;
}

async function resolveDaemonRelease(tag: string | null): Promise<DaemonRelease> {
  const releaseTag = tag ?? (await fetchLatestStableTag());
  const releaseURL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/${encodeURIComponent(releaseTag)}`;
  const downloadURL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${encodeURIComponent(releaseTag)}/${DAEMON_ASSET_NAME}`;
  const checksumsURL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${encodeURIComponent(releaseTag)}/${CHECKSUMS_ASSET_NAME}`;
  const sha256 = await fetchSha256FromChecksums(checksumsURL, DAEMON_ASSET_NAME, releaseTag);
  return { tag: releaseTag, downloadURL, sha256, checksumsURL, releaseURL };
}

async function fetchLatestStableTag(): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "cmux-freestyle-setup",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = githubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
    { headers },
  );
  if (response.status === 403 || response.status === 429) {
    const reset = response.headers.get("x-ratelimit-reset");
    const hint = token
      ? "Your GITHUB_TOKEN does not have access; check repo visibility."
      : "Set GITHUB_TOKEN (or GH_TOKEN) to lift the unauthenticated 60/hr GitHub API rate limit.";
    throw new Error(
      `GitHub API rate limited (HTTP ${response.status}${reset ? `, reset at ${new Date(Number(reset) * 1000).toISOString()}` : ""}). ${hint}`,
    );
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub releases/latest returned ${response.status}: ${body.slice(0, 200)}`,
    );
  }
  const json = (await response.json()) as { tag_name?: unknown };
  const tag = typeof json.tag_name === "string" ? json.tag_name.trim() : "";
  if (!tag) {
    throw new Error("GitHub releases/latest did not include a tag_name");
  }
  return tag;
}

function githubToken(): string | null {
  const candidates = [process.env.GITHUB_TOKEN, process.env.GH_TOKEN];
  for (const value of candidates) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

async function fetchSha256FromChecksums(
  checksumsURL: string,
  assetName: string,
  releaseTag: string,
): Promise<string> {
  const headers: Record<string, string> = { "User-Agent": "cmux-freestyle-setup" };
  const token = githubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(checksumsURL, { headers });
  if (!response.ok) {
    throw new Error(
      `Could not fetch ${CHECKSUMS_ASSET_NAME} for ${releaseTag} from ${checksumsURL}: HTTP ${response.status}. ` +
        `The selected release may pre-date cmuxd-remote distribution; pick a newer tag with --release.`,
    );
  }
  const body = await response.text();
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 2) continue;
    const [sha, name] = parts;
    if (name === assetName) {
      if (!/^[0-9a-f]{64}$/i.test(sha ?? "")) {
        throw new Error(`Invalid SHA-256 entry for ${assetName} in ${CHECKSUMS_ASSET_NAME}: ${sha}`);
      }
      return (sha ?? "").toLowerCase();
    }
  }
  throw new Error(
    `${CHECKSUMS_ASSET_NAME} for ${releaseTag} did not contain a ${assetName} entry. ` +
      "Try a different --release tag.",
  );
}

function freestyleBaseDockerfileContent(opts: {
  readonly daemonURL: string;
  readonly daemonSha256: string;
  readonly nodeMajor: string;
  readonly bunVersion: string;
  readonly tools: ReadonlyArray<ResolvedAgentTool>;
}): string {
  return [
    "FROM ubuntu:24.04",
    `ENV LANG=${UTF8_LOCALE} LC_ALL=${UTF8_LOCALE} LANGUAGE=${UTF8_LOCALE}`,
    `RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${CLOUD_SHELL_PACKAGES.join(" ")} && rm -rf /var/lib/apt/lists/*`,
    ...pythonOpenSSLCommands().map((cmd) => `RUN ${cmd}`),
    `RUN curl -fsSL ${shellQuote(opts.daemonURL)} -o /usr/local/bin/cmuxd-remote ` +
      `&& printf '%s  /usr/local/bin/cmuxd-remote\\n' ${shellQuote(opts.daemonSha256)} | sha256sum -c - ` +
      "&& chmod 0755 /usr/local/bin/cmuxd-remote",
    ...toolInstallCommands(opts.nodeMajor, opts.bunVersion, opts.tools).map((cmd) => `RUN ${cmd}`),
    ...rootSetupCommands().map((cmd) => `RUN ${cmd}`),
    ...imageSmokeTestCommands(opts.tools).map((cmd) => `RUN ${cmd}`),
    "RUN mkdir -p /etc/systemd/system/multi-user.target.wants",
    "RUN cat <<'EOF' >/etc/systemd/system/cmuxd-ws.service\n" +
      "[Unit]\nDescription=cmuxd websocket daemon\nAfter=network.target\n\n" +
      "[Service]\nType=simple\nUser=root\n" +
      "ExecStart=/usr/local/bin/cmuxd-remote serve --ws --listen 0.0.0.0:7777 " +
      "--auth-lease-file /tmp/cmux/attach-pty-lease.json " +
      "--rpc-auth-lease-file /tmp/cmux/attach-rpc-lease.json --shell /bin/bash\n" +
      "Restart=always\nRestartSec=1\n\n[Install]\nWantedBy=multi-user.target\nEOF",
    "RUN ln -sf /etc/systemd/system/cmuxd-ws.service /etc/systemd/system/multi-user.target.wants/cmuxd-ws.service",
  ].join("\n");
}

function pythonOpenSSLCommands(): ReadonlyArray<string> {
  return [
    "apt-get update",
    "mkdir -p /tmp/cmux-libssl /opt/cmux/openssl/lib",
    "cd /tmp/cmux-libssl && apt-get download libssl3t64",
    "dpkg-deb -x /tmp/cmux-libssl/libssl3t64_*.deb /tmp/cmux-libssl/root",
    "cp /tmp/cmux-libssl/root/usr/lib/*-linux-gnu/libssl.so.3 /opt/cmux/openssl/lib/",
    "cp /tmp/cmux-libssl/root/usr/lib/*-linux-gnu/libcrypto.so.3 /opt/cmux/openssl/lib/",
    "cat <<'EOF' >/usr/local/bin/python3\n#!/bin/sh\nexport LD_LIBRARY_PATH=\"/opt/cmux/openssl/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\"\nexec /usr/bin/python3 \"$@\"\nEOF",
    "chmod 0755 /usr/local/bin/python3",
    "ln -sf /usr/local/bin/python3 /usr/local/bin/python",
    "rm -rf /tmp/cmux-libssl /var/lib/apt/lists/*",
  ];
}

function toolInstallCommands(
  nodeMajor: string,
  bunVersion: string,
  tools: ReadonlyArray<ResolvedAgentTool>,
): ReadonlyArray<string> {
  const installAgentTools =
    tools.length > 0
      ? `npm install -g --omit=dev --no-audit --fund=false ${tools
          .map((tool) => shellQuote(tool.packageSpec))
          .join(" ")} >/tmp/cmux-npm-install.txt 2>&1`
      : "true";
  return [
    "install -d -m 0755 /etc/apt/keyrings",
    "rm -f /etc/apt/keyrings/nodesource.gpg",
    "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg",
    `printf '%s\\n' ${shellQuote(`deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${nodeMajor}.x nodistro main`)} > /etc/apt/sources.list.d/nodesource.list`,
    "apt-get update",
    "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs",
    "npm config set fund false",
    "npm config set audit false",
    bunInstallCommand(bunVersion),
    "ln -sf /usr/local/bin/bun /usr/local/bin/bunx",
    installAgentTools,
    "rm -rf /root/.npm/_cacache /var/lib/apt/lists/*",
  ];
}

function bunInstallCommand(bunVersion: string): string {
  const tag = `bun-v${bunVersion}`;
  const commands = [
    "set -eu",
    "rm -rf /tmp/cmux-bun-install",
    "mkdir -p /tmp/cmux-bun-install",
    "cd /tmp/cmux-bun-install",
    'arch="$(dpkg --print-architecture)"',
    'case "${arch##*-}" in amd64) build="x64-baseline" ;; arm64) build="aarch64" ;; *) echo "unsupported architecture: $arch"; exit 1 ;; esac',
    `tag=${shellQuote(tag)}`,
    'release="https://github.com/oven-sh/bun/releases/download/$tag"',
    'curl -fsSLO --compressed --retry 5 "$release/bun-linux-$build.zip"',
    'for key in F3DCC08A8572C0749B3E18888EAB4D40A7B22B59; do gpg --batch --keyserver hkps://keys.openpgp.org --recv-keys "$key" || gpg --batch --keyserver keyserver.ubuntu.com --recv-keys "$key"; done',
    'curl -fsSLO --compressed --retry 5 "$release/SHASUMS256.txt.asc"',
    "gpg --batch --decrypt --output SHASUMS256.txt SHASUMS256.txt.asc",
    'grep " bun-linux-$build.zip$" SHASUMS256.txt | sha256sum -c -',
    'unzip -q "bun-linux-$build.zip"',
    'install -m 0755 "bun-linux-$build/bun" /usr/local/bin/bun',
    "rm -rf /tmp/cmux-bun-install",
  ];
  return `{ ${commands.join(" && ")}; } >/tmp/cmux-bun-install.txt 2>&1`;
}

function rootSetupCommands(): ReadonlyArray<string> {
  return [
    `printf 'LANG=${UTF8_LOCALE}\\nLC_ALL=${UTF8_LOCALE}\\n' > /etc/default/locale`,
    `useradd -m -s /bin/bash ${PRIMARY_LINUX_USER} || true`,
    `printf '${PRIMARY_LINUX_USER} ALL=(ALL) NOPASSWD:ALL\\n' > /etc/sudoers.d/90-${PRIMARY_LINUX_USER}-nopasswd`,
    `chmod 0440 /etc/sudoers.d/90-${PRIMARY_LINUX_USER}-nopasswd`,
    "if id -u user >/dev/null 2>&1; then printf 'user ALL=(ALL) NOPASSWD:ALL\\n' > /etc/sudoers.d/91-user-nopasswd && chmod 0440 /etc/sudoers.d/91-user-nopasswd; fi",
    "mkdir -p /tmp/cmux && chmod 700 /tmp/cmux",
    "ln -sf /usr/local/bin/cmuxd-remote /usr/local/bin/cmux",
  ];
}

function imageSmokeTestCommands(tools: ReadonlyArray<ResolvedAgentTool>): ReadonlyArray<string> {
  const toolChecks = tools.flatMap((tool) =>
    tool.binaries.map(
      (binary) => `${binary} --version >/tmp/cmux-${tool.name}-version.txt 2>&1`,
    ),
  );
  return [
    "openssl version -a >/tmp/cmux-openssl-version.txt 2>&1",
    "python3 -X faulthandler -c 'import ssl; print(ssl.OPENSSL_VERSION)'",
    "python3 -m http.server --help >/dev/null",
    "node --version >/tmp/cmux-node-version.txt 2>&1",
    "npm --version >/tmp/cmux-npm-version.txt 2>&1",
    "bun --version >/tmp/cmux-bun-version.txt 2>&1",
    "cmux --help >/tmp/cmux-cli-help.txt 2>&1",
    'cmux --socket /tmp/cmux-browser-smoke.sock browser >/tmp/cmux-browser-help.txt 2>&1; status=$?; test "$status" -eq 2 && grep -q \'requires a subcommand\' /tmp/cmux-browser-help.txt',
    "cmuxd-remote version >/tmp/cmuxd-remote-version.txt 2>&1",
    ...toolChecks,
  ];
}

type FreestyleSnapshotRecord = {
  readonly snapshotId: string;
  readonly cancelled?: boolean | null;
  readonly createdAt?: string;
  readonly deleted?: boolean | null;
  readonly failed?: boolean | null;
  readonly failureReason?: string | null;
  readonly lost?: boolean | null;
  readonly name?: string | null;
  readonly state?: string | null;
};

async function waitForFreestyleSnapshotByName(
  fs: Freestyle,
  name: string,
  notBefore: string,
  timeoutMs: number,
): Promise<FreestyleSnapshotRecord | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    while (!controller.signal.aborted) {
      const snapshot = await findFreestyleSnapshotByName(fs, name, notBefore, controller.signal);
      if (snapshot) return snapshot;
      await waitForRetryInterval(SNAPSHOT_RECOVERY_POLL_INTERVAL_MS, controller.signal);
    }
    return null;
  } catch (err) {
    if (controller.signal.aborted) return null;
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function findFreestyleSnapshotByName(
  fs: Freestyle,
  name: string,
  notBefore: string,
  signal: AbortSignal,
): Promise<FreestyleSnapshotRecord | null> {
  const response = await (fs as unknown as {
    fetch(url: string, init: { method: string; signal: AbortSignal }): Promise<Response>;
  }).fetch(freestyleSnapshotListURL(), { method: "GET", signal });
  if (!response.ok) {
    throw new Error(
      `Freestyle snapshot list failed: HTTP ${response.status} ${await response.text()}`,
    );
  }
  const json = (await response.json()) as { snapshots?: ReadonlyArray<FreestyleSnapshotRecord> | null };
  const matches = (json.snapshots ?? [])
    .filter(
      (snap) =>
        snap.name === name &&
        snap.deleted !== true &&
        typeof snap.createdAt === "string" &&
        snap.createdAt >= notBefore,
    )
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const latest = matches[0];
  if (!latest) return null;
  if (
    latest.failed === true ||
    latest.cancelled === true ||
    latest.lost === true ||
    latest.failureReason
  ) {
    throw new Error(
      `Freestyle snapshot ${name} failed: ${latest.failureReason ?? latest.state ?? "unknown failure"}`,
    );
  }
  if (latest.state !== "ready") return null;
  return latest;
}

function freestyleSnapshotListURL(): string {
  const base = (process.env.FREESTYLE_API_URL ?? "https://api.freestyle.sh").replace(/\/+$/, "");
  const url = new URL("/v1/vms/snapshots", base);
  url.searchParams.set("includeDeleted", "false");
  url.searchParams.set("includeFailed", "true");
  return url.toString();
}

function recoveryWindowStart(startedAt: Date): string {
  return new Date(startedAt.getTime() - SNAPSHOT_RECOVERY_CLOCK_SKEW_MS).toISOString();
}

function fetchWithTimeout(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (init?.signal) {
        if (init.signal.aborted) {
          controller.abort();
        } else {
          init.signal.addEventListener("abort", onAbort, { once: true });
        }
      }
      return await fetch(input, { ...(init ?? {}), signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      init?.signal?.removeEventListener("abort", onAbort);
    }
  };
}

function waitForRetryInterval(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("operation aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("operation aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function extractSnapshotId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  const value = record.snapshotId ?? record.id ?? record.templateId ?? record.name;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pinnedNpmPackageVersion(packageSpec: string): string | null {
  const trimmed = packageSpec.trim();
  const versionSeparator = trimmed.startsWith("@")
    ? trimmed.indexOf("@", 1)
    : trimmed.lastIndexOf("@");
  if (versionSeparator <= 0) return null;
  const version = trimmed.slice(versionSeparator + 1).trim();
  if (!STRICT_SEMVER_RE.test(version)) return null;
  return version;
}

function isDisabledValue(value: string): boolean {
  return ["0", "false", "off", "disabled", "none"].includes(value.trim().toLowerCase());
}

function positiveIntFromEnv(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${key} must be a positive integer; got ${raw}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${key} must be a safe positive integer; got ${raw}`);
  }
  return parsed;
}

function boolFromEnv(key: string): boolean {
  const raw = process.env[key]?.trim().toLowerCase();
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw);
}

function semverOrFallback(value: string | undefined, fallback: string): string {
  const v = (value ?? "").trim() || fallback;
  if (!STRICT_SEMVER_RE.test(v)) {
    throw new Error(`Expected an exact semver version; got ${v}`);
  }
  return v;
}

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required. Get one from https://dash.freestyle.sh.`);
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function errorSummary(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function log(args: Args, message: string): void {
  if (args.json) return;
  process.stderr.write(`[cmux-freestyle] ${message}\n`);
}
