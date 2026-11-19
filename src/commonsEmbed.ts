// Agent commons coordinators that run inside this service: for each
// community commons.config.json names, the backend runs agent-commons'
// `commons host` as a child process, on 127.0.0.1 and the community's own
// internal port, with its own folder $DATA_DIR/commons/<community> (the
// ledger, the keys, the coordinator's clone of the target). Agents reach it
// through the backend, at https://<backend>/commons/<community>/... (the API
// under /api/, the playground at /), which this proxies to the child; Anthill's
// own relay (commonsAgents.ts) calls the child directly on 127.0.0.1.
//
// - Which code: agent-commons pinned at one exact commit, the
//   "agent-commons" dependency in package.json (`github:kelemeno/agent-commons#<40 hex>`),
//   the one place the pin lives. A deploy restarts the coordinator, but its
//   code only changes when that line is bumped on purpose. It is separate
//   from the kit agents install (COMMONS_KIT_COMMIT / DEFAULT_KIT_COMMIT in
//   commonsAgents.ts). The child runs it with this package's tsx (a
//   dependency, not a dev one: Render's build must install it).
// - When: on Render (RENDER=true) or with COMMONS_EMBED=true; COMMONS_EMBED=false
//   turns it off even on Render. Off chain only (the child needs
//   /commons/key and the community's signed tree). A community COMMONS_SITES
//   names is the operator's commons elsewhere: none is started for it.
// - Config is code: commons.config.json, `{ "<community>": { "target":
//   "https://...", "kernelSigners": ["0x..."], "preset": "...", "port":
//   5101, "rulesPreset"?: "phase1" | "solo" } }`. The preset is passed as it
//   is: the pinned commons decides which names it knows (at setup only).
//   rulesPreset switches an existing ledger's rules to that preset
//   (`commons host --rules-preset`, COMMONS_RULES_PRESET there): once per
//   value, at the next start after a deploy, so leaving solo (phase1), or
//   applying a newer pin's solo rules to a ledger set up under an older
//   one, needs no shell. Leaving solo while solo-reviewed work is stranded
//   is refused there (it serves on under the rules as they are, and says
//   why in the log). Before starting a child the backend asks the
//   pinned commons (`commons host --check`, same flags) whether it can start:
//   one it can't (a preset the pin doesn't know yet, on a fresh disk) isn't
//   started, and that is logged, until a deploy that fixes it. For local tests,
//   off Render, COMMONS_EMBED_OVERRIDE (the same JSON, any fields, for
//   communities the file names) changes it, and
//   COMMONS_EMBED_TEST_FILE_TARGET=true lets a target be a file: URL
//   (agent-commons' --test-allow-file-target); on Render both are ignored.
// - Supervision: the child starts after the backend's log has loaded (its
//   setup asks this backend for its key and the tree). When it exits it is
//   restarted with backoff (5 s doubling to 10 minutes, back to 5 s after
//   10 minutes up); nothing about it can stop the backend. The backend's
//   SIGTERM or SIGINT stops it (its process group: git too) before the
//   backend exits. Its output goes to the backend's log, each line prefixed
//   "[commons <community>]". Its environment has only PATH, HOME, the
//   locale and temp variables, none of the backend's.
// - Advertised (community summaries, agent.md, the Agents page and the
//   relay, see offchainApi.ts) only once it has been set up: its ledger is
//   on the disk. Before that (setting up, or never started) the community
//   has no commons, rather than one that always answers 503. Once set up it
//   stays advertised, down or not: agents there must stay revocable.
// - Not an isolation boundary. The child runs as the backend's own OS user,
//   on the same disk: a clean environment keeps the backend's secrets out of
//   its environment, nothing more. Code running in it (a bug in the
//   coordinator, tsx or git, exploited by an entry, a patch or a playground
//   request) can read $DATA_DIR/session-secret (the session key, when
//   SESSION_SECRET isn't set: it forges a session for any account),
//   $DATA_DIR/commons-signing-key (Anthill's commons signing key), rewrite
//   $DATA_DIR/log.jsonl, and read the backend's environment
//   (/proc/<pid>/environ: ADMIN_TOKEN, GOOGLE_CLIENT_SECRET). A compromised
//   coordinator is a compromised backend.
// - What it runs here, in Phase 1: no repository code. Findings aren't
//   reproduced without --sandbox and merges are git merge-tree; git runs
//   with hooks, fsmonitor and LFS filters off, and the clone uses no
//   credentials (agent-commons' README, Hosting). Real stakes, or test runs
//   of strangers' code, move it to its own service (or the runs to CI),
//   which is also what makes it a boundary: its own disk and user.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { isLoopback } from "./http";

const ROOT = join(__dirname, "..");
export const CONFIG_PATH = join(ROOT, "commons.config.json");
const PACKAGE_PATH = join(ROOT, "package.json");

// The pin, as package.json must spell it: an exact commit, nothing that moves.
export const COMMONS_PIN = /^github:kelemeno\/agent-commons#([0-9a-f]{40})$/;

// The largest body the pinned coordinator takes on any route (its
// DEFAULT_LIMITS.patchBytes, a patch upload; entries are 32 KiB and finding
// tests 256 KiB): the proxy refuses only what's bigger, and the coordinator
// holds each route to its own limit. embedChecks.ts checks this against the
// pinned source.
export const MAX_PROXY_BODY = 1024 * 1024;
// longer than the coordinator's own response timeout (60 s)
const PROXY_TIMEOUT_MS = 120_000;

// Restarts: the first after MIN, doubling to MAX; a child that was up for
// HEALTHY starts over at MIN. On shutdown it has STOP_GRACE to exit after
// SIGTERM, then SIGKILL.
const RESTART_MIN_MS = 5_000;
const RESTART_MAX_MS = 10 * 60_000;
const HEALTHY_MS = 10 * 60_000;
const STOP_GRACE_MS = 5_000;
const MAX_LOG_LINE = 4_000;

////////////////////////////////////////////
//// config

export type EmbeddedCommons = {
  community: string;
  // the repository it builds, and who signs off its kernel
  target: string;
  kernelSigners: string[];
  preset: string;
  // switch an existing ledger's rules to this preset (once per value)
  rulesPreset?: (typeof RULES_PRESETS)[number];
  // the child's own port, on 127.0.0.1
  port: number;
  // where the backend serves it: /commons/<community>
  basePath: string;
  // what agents and the website are given, and what the relay calls
  publicUrl: string;
  internalUrl: string;
  // agent-commons' --test-allow-file-target (local tests only)
  allowFileTarget: boolean;
};

export type Embed = {
  communities: EmbeddedCommons[];
  // the pinned agent-commons commit
  commit: string;
  // where the children keep their folders, and the URL they reach Anthill at
  dataDir: string;
  anthillUrl: string;
};

const COMMUNITY_ID = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
// /commons/<id> must not shadow the backend's own /commons/... routes
const RESERVED = new Set(["key", "tree", "owner", "pairings", "agents"]);
const USER_ID = /^0x[0-9a-f]{40}$/;
const PRESET = /^[a-z0-9][a-z0-9-]{0,31}$/;
// The presets `commons host --rules-preset` takes (agent-commons rules.ts
// PRESETS; embedChecks.ts checks them against the pin). Unlike the setup
// preset, `--check` doesn't judge it: an unknown one would stop the child at
// every start, so it's refused here.
export const RULES_PRESETS = ["phase1", "solo"] as const;
const FIELDS = new Set(["target", "kernelSigners", "preset", "port", "rulesPreset"]);

// The backend's public address (as offchainApi.ts gives agents): PUBLIC_URL,
// else the one Render gives the service.
export const backendPublicUrl = (env: NodeJS.ProcessEnv = process.env) =>
  (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");

export const dataDirOf = (env: NodeJS.ProcessEnv = process.env) => env.DATA_DIR || join(process.cwd(), "data");

export function embedActive(env: NodeJS.ProcessEnv = process.env) {
  if (env.COMMONS_EMBED === "false") return false;
  return env.COMMONS_EMBED === "true" || env.RENDER === "true";
}

// The pinned commit, from package.json's "agent-commons" dependency.
export function pinnedCommit(packageText: string): string {
  let spec: unknown;
  try {
    spec = JSON.parse(packageText).dependencies?.["agent-commons"];
  } catch {
    throw new Error("package.json is not JSON");
  }
  const m = typeof spec === "string" ? COMMONS_PIN.exec(spec) : null;
  if (m === null) throw new Error('package.json: the "agent-commons" dependency must be github:kelemeno/agent-commons#<full 40-character commit>');
  return m[1];
}

// A target the coordinator clones with no credentials, as agent-commons
// checks it (its host.ts: targetRepoProblems): https, no user:token@, no
// query or fragment, a path.
function targetUrl(v: unknown, where: string, allowFile: boolean): string {
  if (typeof v !== "string" || /[\s\\\x00-\x1f\x7f]/.test(v)) throw new Error(`${where} must be a URL without spaces or control characters`);
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error(`${where} is not a URL`);
  }
  if (url.protocol === "file:" && allowFile) return v;
  if (url.protocol !== "https:") throw new Error(`${where} must be an https URL`);
  if (url.username !== "" || url.password !== "" || v.includes("@") || v.includes("?") || v.includes("#")) {
    throw new Error(`${where} must have no credentials, query or fragment`);
  }
  if (url.pathname === "/" || url.pathname === "") throw new Error(`${where} must name a repository`);
  return v;
}

type Entry = { target?: unknown; kernelSigners?: unknown; preset?: unknown; port?: unknown; rulesPreset?: unknown };

function entries(text: string, where: string): Map<string, Entry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${where} is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${where} must be a JSON object of community ids`);
  const out = new Map<string, Entry>();
  for (const [id, value] of Object.entries(parsed)) {
    if (!COMMUNITY_ID.test(id) || RESERVED.has(id)) throw new Error(`${where}: ${JSON.stringify(id)} is not a community id it can serve`);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where}: ${id} must be an object`);
    const unknown = Object.keys(value).filter((k) => !FIELDS.has(k));
    if (unknown.length > 0) throw new Error(`${where}: ${id} has unknown fields ${unknown.join(", ")}`);
    out.set(id, value as Entry);
  }
  return out;
}

export type ReadEmbed = { embed: Embed | null; notes: string[] };

// The coordinators this backend runs, or null when it runs none. A mistake
// in the config (the file, or the override) throws: the server doesn't
// start, rather than quietly leaving a commons off (as for COMMONS_SITES).
export function readEmbed(o: {
  env?: NodeJS.ProcessEnv;
  // the backend's own port (the children reach it on 127.0.0.1)
  port: number;
  // communities COMMONS_SITES names
  sites?: ReadonlySet<string>;
  configText?: string;
  packageText?: string;
}): ReadEmbed {
  const env = o.env ?? process.env;
  const notes: string[] = [];
  if (!embedActive(env)) return { embed: null, notes };
  const onRender = env.RENDER === "true";
  const file = entries(o.configText ?? readFileSync(CONFIG_PATH, "utf8"), "commons.config.json");
  const override = env.COMMONS_EMBED_OVERRIDE?.trim() ? entries(env.COMMONS_EMBED_OVERRIDE, "COMMONS_EMBED_OVERRIDE") : new Map<string, Entry>();
  const allowFile = env.COMMONS_EMBED_TEST_FILE_TARGET === "true" && !onRender;
  if (onRender && override.size > 0) notes.push("COMMONS_EMBED_OVERRIDE is ignored on Render: change commons.config.json");
  if (onRender && env.COMMONS_EMBED_TEST_FILE_TARGET === "true") notes.push("COMMONS_EMBED_TEST_FILE_TARGET is ignored on Render");
  for (const id of override.keys()) {
    if (!file.has(id)) throw new Error(`COMMONS_EMBED_OVERRIDE: ${id} isn't in commons.config.json`);
  }
  const commit = pinnedCommit(o.packageText ?? readFileSync(PACKAGE_PATH, "utf8"));
  const backend = backendPublicUrl(env) || `http://localhost:${o.port}`;
  const ports = new Set<number>([o.port]);
  const communities: EmbeddedCommons[] = [];
  for (const [community, fromFile] of file) {
    const where = (field: string) => `${!onRender && override.get(community)?.[field as keyof Entry] !== undefined ? "COMMONS_EMBED_OVERRIDE" : "commons.config.json"}: ${community}.${field}`;
    const e: Entry = { ...fromFile, ...(onRender ? {} : override.get(community)) };
    const target = targetUrl(e.target, where("target"), allowFile);
    if (!Array.isArray(e.kernelSigners) || e.kernelSigners.length === 0) throw new Error(`${where("kernelSigners")} must list at least one Anthill user id`);
    const kernelSigners: string[] = [];
    for (const s of e.kernelSigners) {
      if (typeof s !== "string" || !USER_ID.test(s)) throw new Error(`${where("kernelSigners")}: ${JSON.stringify(s)} is not an Anthill user id (0x and 40 lowercase hex digits)`);
      if (kernelSigners.includes(s)) throw new Error(`${where("kernelSigners")} names ${s} twice`);
      kernelSigners.push(s);
    }
    if (typeof e.preset !== "string" || !PRESET.test(e.preset)) throw new Error(`${where("preset")} must be a preset name, like phase1`);
    if (e.rulesPreset !== undefined && !RULES_PRESETS.includes(e.rulesPreset as (typeof RULES_PRESETS)[number])) {
      throw new Error(`${where("rulesPreset")} must be one of ${RULES_PRESETS.join(", ")} (or left out)`);
    }
    if (typeof e.port !== "number" || !Number.isInteger(e.port) || e.port < 1024 || e.port > 65535) throw new Error(`${where("port")} must be a port from 1024 to 65535`);
    if (ports.has(e.port)) throw new Error(`${where("port")}: ${e.port} is already the backend's or another commons' port`);
    ports.add(e.port);
    if (o.sites?.has(community)) {
      notes.push(`${community}: COMMONS_SITES names it, so its commons is the one there and none runs here`);
      continue;
    }
    const basePath = `/commons/${community}`;
    communities.push({
      community,
      target,
      kernelSigners,
      preset: e.preset,
      ...(e.rulesPreset === undefined ? {} : { rulesPreset: e.rulesPreset as (typeof RULES_PRESETS)[number] }),
      port: e.port,
      basePath,
      publicUrl: `${backend}${basePath}`,
      internalUrl: `http://127.0.0.1:${e.port}${basePath}`,
      allowFileTarget: allowFile,
    });
  }
  // absolute: the child runs in its own folder
  return { embed: { communities, commit, dataDir: resolve(dataDirOf(env)), anthillUrl: `http://127.0.0.1:${o.port}` }, notes };
}

// Whether a request path is one of the proxied ones.
export const embeddedPath = (list: readonly EmbeddedCommons[], path: string) =>
  list.some((c) => path === c.basePath || path.startsWith(`${c.basePath}/`));

// `mw` everywhere but the proxied paths (the backend's body limit and POST
// budget: the coordinator has its own).
export const exceptProxied =
  (list: readonly EmbeddedCommons[], mw: MiddlewareHandler): MiddlewareHandler =>
  (c, next) =>
    list.length > 0 && embeddedPath(list, c.req.path) ? next() : mw(c, next);

////////////////////////////////////////////
//// running it

export type Runtime = { node: string; tsx: string; cli: string };

// What the child needs, checked before it's started: the pinned commons as
// installed (the commit npm installed must be the pin: a stale install would
// run other code against the ledger), this package's tsx, git, Node 22.
// Problems are returned, never thrown.
export function commonsRuntime(commit: string): { runtime?: Runtime; problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  let cli = "";
  let tsx = "";
  try {
    cli = require.resolve("agent-commons/src/cli.ts");
  } catch {
    problems.push("agent-commons isn't installed (npm install)");
  }
  try {
    tsx = pathToFileURL(require.resolve("tsx")).href;
  } catch {
    problems.push("tsx isn't installed (npm install: it's a dependency)");
  }
  if (cli !== "") {
    const lock = join(dirname(require.resolve("agent-commons/package.json")), "..", ".package-lock.json");
    let installed: string | undefined;
    try {
      const resolved = JSON.parse(readFileSync(lock, "utf8")).packages?.["node_modules/agent-commons"]?.resolved;
      installed = typeof resolved === "string" ? /#([0-9a-f]{40})$/.exec(resolved)?.[1] : undefined;
    } catch {
      installed = undefined;
    }
    if (installed === undefined) notes.push(`can't tell which agent-commons commit npm installed (no ${lock}); assuming the pin`);
    else if (installed !== commit) problems.push(`agent-commons ${installed} is installed, but package.json pins ${commit} (npm install)`);
  }
  const git = spawnSync("git", ["--version"], { stdio: "ignore", timeout: 10_000 });
  if (git.status !== 0) problems.push("git isn't on the PATH");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) problems.push(`agent-commons needs Node 22 or later (this is ${process.versions.node})`);
  return { ...(problems.length === 0 ? { runtime: { node: process.execPath, tsx, cli } } : {}), problems, notes };
}

export type ChildSpec = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };

// A community's folder, and its ledger: there once the coordinator is set up.
export const childDataDir = (c: EmbeddedCommons, embed: Embed) => join(embed.dataDir, "commons", c.community);
export const ledgerOf = (c: EmbeddedCommons, embed: Embed) => join(childDataDir(c, embed), "commons-ledger.jsonl");

// Whether the coordinator has been set up (its ledger is there): until then
// Anthill doesn't advertise it. Once true, true for good (a ledger isn't
// taken away while the backend runs).
export function setUpCheck(c: EmbeddedCommons, embed: Embed): () => boolean {
  const ledger = ledgerOf(c, embed);
  let seen = false;
  return () => (seen ||= existsSync(ledger));
}

// Only these reach the child's environment: none of the backend's secrets
// there. (Not isolation: the child is the same OS user, see the top.)
const CHILD_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "COMMONS_DEBUG"];

// `commons host` for one community: it sets itself up on its first start
// (clones the target with a dev branch, makes its keys, init linked to the
// community on this backend), then serves the API and the playground under
// its base path, with a coordinator pass every 30 seconds. Without
// --hold-on-failure it exits 2 when it can't go on, and is restarted.
// --embedded: the backend lists its site itself, so setup prints no
// COMMONS_SITES line to set.
export function childSpec(c: EmbeddedCommons, embed: Embed, rt: Runtime, env: NodeJS.ProcessEnv = process.env): ChildSpec {
  const data = childDataDir(c, embed);
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV) if (env[name] !== undefined) childEnv[name] = env[name];
  return {
    command: rt.node,
    args: [
      "--import", rt.tsx, rt.cli, "host",
      "--data", data,
      "--host", "127.0.0.1",
      "--port", String(c.port),
      "--base-path", c.basePath,
      "--trusted-proxy", "loopback",
      "--public-url", c.publicUrl,
      "--anthill-url", embed.anthillUrl,
      "--community", c.community,
      "--target-repo", c.target,
      ...c.kernelSigners.flatMap((s) => ["--kernel-signer", s]),
      "--preset", c.preset,
      ...(c.rulesPreset === undefined ? [] : ["--rules-preset", c.rulesPreset]),
      "--embedded",
      "--loop-seconds", "30",
      ...(c.allowFileTarget ? ["--test-allow-file-target"] : []),
    ],
    cwd: data,
    env: childEnv,
  };
}

export type SupervisorOptions = {
  log?: (line: string, stream: "out" | "err") => void;
  minDelayMs?: number;
  maxDelayMs?: number;
  healthyMs?: number;
  stopGraceMs?: number;
};

// One child, kept running: restarted with backoff whenever it exits, until
// stop(). Nothing here throws into the backend.
export class Supervisor {
  private child: ChildProcess | undefined;
  private timer: NodeJS.Timeout | undefined;
  private failures = 0;
  private startedAt = 0;
  private stopping = false;
  private exitWaiters: (() => void)[] = [];
  // how many times it was started (for the checks)
  starts = 0;

  constructor(
    readonly name: string,
    private spec: ChildSpec,
    private o: SupervisorOptions = {},
  ) {}

  private log(line: string, stream: "out" | "err" = "out") {
    const clean = line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, MAX_LOG_LINE);
    if (this.o.log) this.o.log(`[commons ${this.name}] ${clean}`, stream);
    else if (stream === "err") console.error(`[commons ${this.name}] ${clean}`);
    else console.log(`[commons ${this.name}] ${clean}`);
  }

  get running() {
    return this.child !== undefined;
  }

  get pid() {
    return this.child?.pid;
  }

  start() {
    this.stopping = false;
    if (this.child === undefined && this.timer === undefined) this.launch();
  }

  private launch() {
    this.timer = undefined;
    if (this.stopping) return;
    this.starts += 1;
    let child: ChildProcess;
    try {
      // its own process group, so stopping it stops what it runs (git) too
      child = spawn(this.spec.command, this.spec.args, { cwd: this.spec.cwd, env: this.spec.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e) {
      this.log(`could not start: ${(e as Error).message}`, "err");
      this.ended();
      return;
    }
    this.child = child;
    this.startedAt = Date.now();
    this.pipe(child.stdout, "out");
    this.pipe(child.stderr, "err");
    let over = false;
    const end = (why: string) => {
      if (over) return;
      over = true;
      if (this.child === child) this.child = undefined;
      this.log(why, this.stopping ? "out" : "err");
      this.ended();
    };
    child.on("error", (e) => {
      // a spawn that failed (no such file, say) has no pid and may never exit
      if (child.pid === undefined) end(`could not start: ${e.message}`);
      else this.log(`error: ${e.message}`, "err");
    });
    child.on("exit", (code, signal) => end(signal !== null ? `stopped by ${signal}` : `exited with code ${code}`));
  }

  private pipe(stream: Readable | null, kind: "out" | "err") {
    if (stream === null) return;
    stream.on("error", () => {});
    createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => this.log(line, kind));
  }

  private ended() {
    if (this.stopping) {
      for (const w of this.exitWaiters.splice(0)) w();
      return;
    }
    if (this.startedAt > 0 && Date.now() - this.startedAt >= (this.o.healthyMs ?? HEALTHY_MS)) this.failures = 0;
    const delay = Math.min((this.o.minDelayMs ?? RESTART_MIN_MS) * 2 ** this.failures, this.o.maxDelayMs ?? RESTART_MAX_MS);
    this.failures = Math.min(this.failures + 1, 30);
    this.log(`restarting in ${Math.round(delay / 1000)} s`, "err");
    this.timer = setTimeout(() => this.launch(), delay);
    this.timer.unref();
  }

  private signal(sig: NodeJS.Signals) {
    const child = this.child;
    if (child?.pid === undefined) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // gone already
      }
    }
  }

  // Stops it (SIGTERM, then SIGKILL after the grace) and doesn't restart it.
  stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.child === undefined) return Promise.resolve();
    const grace = this.o.stopGraceMs ?? STOP_GRACE_MS;
    return new Promise<void>((resolve) => {
      const kill = setTimeout(() => this.signal("SIGKILL"), grace);
      const giveUp = setTimeout(done, grace + 2_000);
      function done() {
        clearTimeout(kill);
        clearTimeout(giveUp);
        resolve();
      }
      this.exitWaiters.push(done);
      this.signal("SIGTERM");
    });
  }

  // At the backend's exit, whatever caused it (synchronous: an exit handler).
  killNow() {
    this.stopping = true;
    this.signal("SIGKILL");
  }
}

// The same command with --check: `commons host` then only says whether it
// can start (0: its ledger is there, or the setup settings are valid; 1:
// some are missing; 2: one is invalid, a preset the pin doesn't know, say),
// printing why, and touches nothing.
export function checkSpec(spec: ChildSpec): ChildSpec {
  const at = spec.args.indexOf("host");
  return { ...spec, args: [...spec.args.slice(0, at + 1), "--check", ...spec.args.slice(at + 1)] };
}

const CHECK_TIMEOUT_MS = 60_000;

// Runs the check: whether the child can start, and what it printed.
function canStart(spec: ChildSpec): Promise<{ ok: boolean; why: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child: ChildProcess;
    try {
      child = spawn(spec.command, checkSpec(spec).args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"], timeout: CHECK_TIMEOUT_MS });
    } catch (e) {
      resolve({ ok: false, why: `could not run the check: ${(e as Error).message}` });
      return;
    }
    const add = (d: Buffer) => {
      if (out.length < MAX_LOG_LINE) out += d.toString("utf8");
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    child.on("error", (e) => resolve({ ok: false, why: `could not run the check: ${e.message}` }));
    child.on("close", (code, signal) => {
      const said = out.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim().split("\n").filter((l) => l.trim() !== "").join("; ").slice(0, MAX_LOG_LINE);
      resolve({ ok: code === 0, why: said || (signal !== null ? `stopped by ${signal}` : `exit code ${code}`) });
    });
  });
}

// Starts a supervised child per community (after the backend's log has
// loaded), and stops them when the backend is told to stop. Returns them:
// none if what the children need is missing, and none for a community
// whose child the pinned commons says can't start (both logged; the backend
// runs on without them, and doesn't advertise a commons never set up).
export async function startEmbedded(
  embed: Embed,
  o: { runtime?: Runtime; env?: NodeJS.ProcessEnv; supervisor?: SupervisorOptions; shutdown?: boolean } = {},
): Promise<Supervisor[]> {
  if (embed.communities.length === 0) return [];
  let rt = o.runtime;
  if (rt === undefined) {
    const checked = commonsRuntime(embed.commit);
    for (const n of checked.notes) console.log(`Agent commons: ${n}`);
    if (checked.runtime === undefined) {
      console.error(`Agent commons: not starting the coordinators (${embed.communities.map((c) => c.community).join(", ")}): ${checked.problems.join("; ")}`);
      return [];
    }
    rt = checked.runtime;
  }
  const supervisors: Supervisor[] = [];
  for (const c of embed.communities) {
    try {
      const spec = childSpec(c, embed, rt, o.env);
      mkdirSync(spec.cwd, { recursive: true, mode: 0o700 });
      chmodSync(spec.cwd, 0o700);
      const check = await canStart(spec);
      if (!check.ok) {
        console.error(
          `Agent commons ${c.community}: not starting its coordinator: agent-commons ${embed.commit.slice(0, 12)} says it can't start (${check.why}).`,
          "Its community has no commons until a deploy fixes commons.config.json or the pin.",
        );
        continue;
      }
      console.log(
        `Agent commons ${c.community}: coordinator at agent-commons ${embed.commit.slice(0, 12)}, serving ${c.publicUrl} (127.0.0.1:${c.port}),`,
        `building ${c.target} with preset ${c.preset}${c.rulesPreset === undefined ? "" : ` (rules preset ${c.rulesPreset}, applied once per value)`}, data in ${spec.cwd}`,
      );
      // Solo needs no kernel sign-off (its kernelSignoffs is 0), so one
      // signer freezes nothing there: the same rule as agent-commons' own
      // host settings (by preset; leaving solo later is commons rules set
      // --kernel-signer's business).
      if (c.kernelSigners.length === 1 && c.preset !== "solo") {
        console.warn(
          `Agent commons ${c.community}: one kernel signer (${c.kernelSigners[0]}). A signer can't sign off a snapshot holding their own ring-0 work,`,
          "so once theirs (or their agent's) merges to dev, main stops moving until there's a second signer; and signing off needs an owner key (anthill join).",
        );
      }
      const s = new Supervisor(c.community, spec, o.supervisor);
      s.start();
      supervisors.push(s);
    } catch (e) {
      console.error(`Agent commons ${c.community}: not started:`, (e as Error).message);
    }
  }
  if (o.shutdown !== false && supervisors.length > 0) stopOnShutdown(supervisors);
  return supervisors;
}

// On SIGTERM or SIGINT the children are stopped, then the backend exits as
// that signal would have made it; on any other exit they're killed.
function stopOnShutdown(supervisors: Supervisor[]) {
  let stopping = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.log(`${sig}: stopping the agent commons coordinators`);
    void Promise.all(supervisors.map((s) => s.stop())).finally(() => {
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
      process.kill(process.pid, sig);
    });
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("exit", () => {
    for (const s of supervisors) s.killNow();
  });
}

////////////////////////////////////////////
//// the proxy

// Not passed on to the child: hop-by-hop headers, the backend's own sign-in
// (sessions, cookies), and addresses a client could have made up (the
// backend says who the client is, below).
const DROP_REQUEST = new Set([
  "host", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "expect",
  "authorization", "cookie", "forwarded", "x-real-ip", "true-client-ip", "accept-encoding",
]);
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "trailer", "upgrade", "set-cookie", "content-encoding"]);

// The address the child is given for a client the backend can't place: one
// that isn't an IP (clientIp falls back to "local"), loopback, which the
// child trusts as its proxy and would charge to the socket's 127.0.0.1,
// Anthill's own relay's address, or unspecified. (TEST-NET-1: never a real
// client.) All of them share its limits there.
export const UNPLACED_CLIENT = "192.0.2.1";
export const forwardedFor = (ip: string) => (isIP(ip) === 0 || isLoopback(ip) || /^(0\.0\.0\.0|::|::ffff:0\.0\.0\.0)$/i.test(ip) ? UNPLACED_CLIENT : ip);

const tooLarge = (c: Context) => c.json({ error: "too-large", message: `body exceeds ${MAX_PROXY_BODY} bytes` }, 413);

// https://<backend>/commons/<community>/... to the child, the full path
// kept (it serves under the same base path): bodies streamed both ways,
// the coordinator's own status, content type and headers (the backend's
// security headers added where it set none, see headers.ts), redirects
// passed back as they are. X-Forwarded-For is the one address the backend
// takes for the client (http.ts: clientIp), so the child, trusting only
// loopback as its proxy, limits each client by it; never a loopback one
// (see UNPLACED_CLIENT), so no client is counted as Anthill's relay. A child that isn't up
// (starting, restarting) is a 503.
export function mountCommonsProxy(
  app: Hono,
  list: readonly EmbeddedCommons[],
  clientIp: (c: Context) => string,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
) {
  for (const commons of list) {
    const origin = `http://127.0.0.1:${commons.port}`;
    const handler = async (c: Context) => {
      const incoming = new URL(c.req.url);
      const headers = new Headers();
      c.req.raw.headers.forEach((value, name) => {
        if (!DROP_REQUEST.has(name) && !name.startsWith("x-forwarded-") && !name.startsWith("cf-") && !name.startsWith("proxy-")) {
          headers.set(name, value);
        }
      });
      headers.set("x-forwarded-for", forwardedFor(clientIp(c)));
      headers.set("accept-encoding", "identity");
      const method = c.req.method;
      const declared = c.req.header("content-length");
      if (declared !== undefined && !(Number(declared) <= MAX_PROXY_BODY)) return tooLarge(c);
      let body: ReadableStream<Uint8Array> | undefined;
      let over = false;
      if (method !== "GET" && method !== "HEAD" && c.req.raw.body !== null) {
        let size = 0;
        body = c.req.raw.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, ctl) {
              size += chunk.byteLength;
              if (size > MAX_PROXY_BODY) {
                over = true;
                ctl.error(new Error("too large"));
                return;
              }
              ctl.enqueue(chunk);
            },
          }),
        );
      }
      let res: Response;
      try {
        res = await fetchFn(`${origin}${incoming.pathname}${incoming.search}`, {
          method,
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(PROXY_TIMEOUT_MS)]),
          duplex: "half",
        } as RequestInit);
      } catch {
        if (over) return tooLarge(c);
        c.header("Retry-After", "30");
        return c.json({ error: "unavailable", message: "This commons is starting or restarting; try again in a minute." }, 503);
      }
      const out = new Headers();
      res.headers.forEach((value, name) => {
        if (!DROP_RESPONSE.has(name)) out.set(name, value);
      });
      // (a body the fetch decoded no longer has its encoded length)
      if (res.headers.has("content-encoding")) out.delete("content-length");
      return new Response(method === "HEAD" ? null : res.body, { status: res.status, statusText: res.statusText, headers: out });
    };
    app.all(commons.basePath, handler);
    app.all(`${commons.basePath}/*`, handler);
  }
}
