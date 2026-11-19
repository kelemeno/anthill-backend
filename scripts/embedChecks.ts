// Checks of the agent commons coordinators this backend runs itself
// (src/commonsEmbed.ts), with nothing on the network but localhost:
// - the config: when it's on (Render, COMMONS_EMBED), the committed
//   commons.config.json, strict refusals, the local overrides (ignored on
//   Render), COMMONS_SITES winning, the public and internal URLs;
// - the pin: package.json names one exact commit, npm installed that one,
//   tsx and git are there, and the pinned source still has what this relies
//   on (its largest body is the proxy's cap, `commons host` takes every flag
//   passed, --embedded and --rules-preset included, loopback as a trusted
//   proxy, the rules presets it knows); the kit agents install is that same
//   commit, and its solo rules soak an hour and its head says solo (what
//   one person testing alone needs); a community the pinned commons
//   says can't start (`commons host --check`: a preset it doesn't know yet)
//   is never started, nor advertised;
// - the child's command line and environment (no backend secrets);
// - the one-time "client IPs:" log line isn't used up by the child's own
//   calls to the backend on 127.0.0.1;
// - the supervisor: log prefix, restarts with backoff, a spawn that fails,
//   stop (SIGTERM, SIGKILL after the grace, the whole process group);
// - the proxy, against a fake coordinator: the full path, bodies streamed
//   both ways and bigger than the backend's 64 KB (up to the coordinator's
//   own largest, then a 413), X-Forwarded-For as the backend reads the
//   client (never a loopback address, which the child would count as
//   Anthill's relay), no sessions or cookies passed on, the coordinator's own headers
//   with the backend's security headers where it set none, redirects passed
//   back, a 503 while the child is down, the backend's own limits unchanged
//   elsewhere;
// - end to end with the pinned commons itself (skip with --no-e2e): a
//   backend on a fresh data dir with a public builders community, its
//   coordinator set up from a local target repository (the test-only file:
//   flag) with the founder as kernel signer, no commons advertised before
//   it's set up, serving through the proxy (the API's head, the playground
//   and its script), the community summary's public URLs, an Agents pairing whose approval is relayed to the child on
//   127.0.0.1 and lands in its ledger, a proposal by that agent approved as a
//   task on the website (approved-tasks.json in the child's folder) that the
//   coordinator's own pass then appends, and the child stopped at the end.
//
//   npx tsx scripts/embedChecks.ts [--no-e2e] [--verbose]   (--verbose: the child's log)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { SoftPasskey } from "./softPasskey";

process.env.RP_ID = "localhost";
process.env.ORIGINS = "http://localhost:5173";
process.env.SEED = "empty";
for (const name of ["SESSION_SECRET", "GOOGLE_CLIENT_ID", "PUBLIC_URL", "RENDER_EXTERNAL_URL", "COMMONS_SITES", "COMMONS_KIT_COMMIT", "RENDER", "COMMONS_EMBED"]) {
  delete process.env[name];
}

const ok = (name: string) => console.log(`ok: ${name}`);
const note = (text: string) => console.log(`note: ${text}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROOT = join(__dirname, "..");

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function until<T>(what: string, ms: number, f: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function main() {
  const e = await import("../src/commonsEmbed");
  const { clientIp } = await import("../src/http");
  const { corsPolicy, securityHeaders } = await import("../src/headers");

  ////////////////////////////////////////////
  //// the one-time "client IPs:" line (first: nothing has called clientIp yet)

  {
    const logged: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void logged.push(args.join(" "));
    const req = (remoteAddress: string, headers: Record<string, string>) => ({
      req: { header: (name: string) => headers[name] },
      env: { incoming: { socket: { remoteAddress } } },
    });
    try {
      // the child's tree fetch: from 127.0.0.1, nothing forwarded
      assert.equal(clientIp(req("127.0.0.1", {})), "127.0.0.1");
      assert.equal(clientIp(req("::ffff:127.0.0.1", {})), "::ffff:127.0.0.1");
      assert.equal(clientIp(req("::1", {})), "::1");
      assert.deepEqual(logged, [], "a loopback call with nothing forwarded doesn't use up the line");
      // the first request through Render's proxy does
      assert.equal(clientIp(req("10.0.0.5", { "x-forwarded-for": "198.51.100.7" })), "198.51.100.7");
      assert.equal(logged.length, 1);
      assert.match(logged[0], /^client IPs: 1 X-Forwarded-For entries on the first proxied request \(0 Cloudflare's on the right\), CF-Connecting-IP absent; using 1 from the right$/);
      clientIp(req("10.0.0.5", { "x-forwarded-for": "198.51.100.8" }));
      assert.equal(logged.length, 1, "once");
    } finally {
      console.log = log;
    }
  }
  ok('the "client IPs:" line is about the first proxied request, not the child\'s own loopback calls');

  ////////////////////////////////////////////
  //// config

  const packageText = readFileSync(join(ROOT, "package.json"), "utf8");
  const configText = readFileSync(join(ROOT, "commons.config.json"), "utf8");
  const PIN = e.pinnedCommit(packageText);
  const KALMAN = "0xa0d64a92e36a7c122b28bd2e4b60b96aa8bd6c3d";
  {
    assert.equal(e.embedActive({}), false);
    assert.equal(e.embedActive({ RENDER: "true" }), true);
    assert.equal(e.embedActive({ COMMONS_EMBED: "true" }), true);
    assert.equal(e.embedActive({ RENDER: "true", COMMONS_EMBED: "false" }), false);
    assert.equal(e.readEmbed({ env: {}, port: 5001 }).embed, null);

    // the committed config, on Render
    const onRender = e.readEmbed({ env: { RENDER: "true", RENDER_EXTERNAL_URL: "https://anthill-backend.onrender.com/", DATA_DIR: "/var/data" }, port: 10000 });
    // builders pushes to GitHub once the token is there; without it, says so
    assert.deepEqual(onRender.notes, ["builders: pushUpstream is set but COMMONS_GITHUB_TOKEN isn't, so its dev and main stay in its own clone"]);
    assert.equal(e.readEmbed({ env: { RENDER: "true", COMMONS_GITHUB_TOKEN: "t" }, port: 10000 }).embed!.communities[0].pushUpstream, true);
    const embed = onRender.embed!;
    assert.equal(embed.commit, PIN);
    assert.equal(embed.dataDir, "/var/data");
    assert.equal(embed.anthillUrl, "http://127.0.0.1:10000");
    assert.deepEqual(embed.communities, [
      {
        community: "builders",
        target: "https://github.com/anthill-ai/agent-commons",
        kernelSigners: [KALMAN],
        preset: "solo",
        port: 5101,
        basePath: "/commons/builders",
        publicUrl: "https://anthill-backend.onrender.com/commons/builders",
        internalUrl: "http://127.0.0.1:5101/commons/builders",
        allowFileTarget: false,
        pushUpstream: false,
      },
    ]);
    // PUBLIC_URL first; locally, this machine
    assert.equal(e.readEmbed({ env: { COMMONS_EMBED: "true", PUBLIC_URL: "https://api.example", RENDER_EXTERNAL_URL: "https://x.onrender.com" }, port: 5001 }).embed!.communities[0].publicUrl, "https://api.example/commons/builders");
    assert.equal(e.readEmbed({ env: { COMMONS_EMBED: "true" }, port: 5411 }).embed!.communities[0].publicUrl, "http://localhost:5411/commons/builders");
    // a relative DATA_DIR is the backend's, not the child's (it runs in its own folder)
    assert.equal(e.readEmbed({ env: { COMMONS_EMBED: "true", DATA_DIR: "rel/data" }, port: 5411 }).embed!.dataDir, join(process.cwd(), "rel", "data"));

    // COMMONS_SITES wins for a community it names
    const named = e.readEmbed({ env: { RENDER: "true" }, port: 10000, sites: new Set(["builders"]) });
    assert.deepEqual(named.embed!.communities, []);
    assert.match(named.notes.join("\n"), /builders: COMMONS_SITES names it/);

    // pushing to GitHub: set in the config, on only with the token, which
    // reaches only that child, through its environment, never its argv
    {
      const cfg = (extra: object) => JSON.stringify({ builders: { target: "https://github.com/anthill-ai/agent-commons", kernelSigners: [KALMAN], preset: "solo", port: 5101, ...extra } });
      const pkg = readFileSync(join(__dirname, "..", "package.json"), "utf8");
      const read = (extra: object, env: NodeJS.ProcessEnv) => e.readEmbed({ env: { RENDER: "true", ...env }, port: 10000, configText: cfg(extra), packageText: pkg });
      const off = read({ pushUpstream: true }, {});
      assert.equal(off.embed!.communities[0].pushUpstream, false);
      assert.match(off.notes.join("\n"), /pushUpstream is set but COMMONS_GITHUB_TOKEN isn't/);
      const token = "github_pat_test_0123456789";
      const on = read({ pushUpstream: true }, { COMMONS_GITHUB_TOKEN: ` ${token}\n` });
      assert.equal(on.embed!.communities[0].pushUpstream, true);
      const fakeRt = { node: "node", tsx: "tsx", cli: "cli" } as Parameters<typeof e.childSpec>[2];
      const pushing = e.childSpec(on.embed!.communities[0], on.embed!, fakeRt, { PATH: "/bin", COMMONS_GITHUB_TOKEN: token, ADMIN_TOKEN: "x" });
      assert.ok(pushing.args.includes("--push-upstream"));
      assert.equal(pushing.env.COMMONS_GITHUB_TOKEN, token);
      assert.equal(pushing.env.ADMIN_TOKEN, undefined);
      assert.ok(!pushing.args.join(" ").includes(token), "the token is never in argv");
      // a commons that doesn't push never gets it
      const quiet = read({}, { COMMONS_GITHUB_TOKEN: token });
      const plain = e.childSpec(quiet.embed!.communities[0], quiet.embed!, fakeRt, { PATH: "/bin", COMMONS_GITHUB_TOKEN: token });
      assert.equal(plain.env.COMMONS_GITHUB_TOKEN, undefined);
      assert.ok(!plain.args.includes("--push-upstream"));
      assert.throws(() => read({ pushUpstream: "yes" }, {}), /pushUpstream must be true or false/);
      assert.throws(() => read({ pushUpstream: true, target: "https://gitlab.com/a/b" }, { COMMONS_GITHUB_TOKEN: token }), /needs a target on https:\/\/github.com/);
    }

    // overrides, off Render only
    const override = JSON.stringify({ builders: { target: "file:///tmp/target", preset: "phase1", kernelSigners: [`0x${"b".repeat(40)}`], port: 5999 } });
    const local = e.readEmbed({ env: { COMMONS_EMBED: "true", COMMONS_EMBED_OVERRIDE: override, COMMONS_EMBED_TEST_FILE_TARGET: "true" }, port: 5411 }).embed!.communities[0];
    assert.deepEqual(
      { target: local.target, preset: local.preset, kernelSigners: local.kernelSigners, port: local.port, allowFileTarget: local.allowFileTarget },
      { target: "file:///tmp/target", preset: "phase1", kernelSigners: [`0x${"b".repeat(40)}`], port: 5999, allowFileTarget: true },
    );
    const ignored = e.readEmbed({ env: { RENDER: "true", RENDER_EXTERNAL_URL: "https://anthill-backend.onrender.com", DATA_DIR: "/var/data", COMMONS_EMBED_OVERRIDE: override, COMMONS_EMBED_TEST_FILE_TARGET: "true" }, port: 10000 });
    assert.deepEqual(ignored.embed!.communities, embed.communities);
    assert.match(ignored.notes.join("\n"), /OVERRIDE is ignored on Render/);
    assert.match(ignored.notes.join("\n"), /TEST_FILE_TARGET is ignored on Render/);
    // a file: target needs the test flag
    assert.throws(() => e.readEmbed({ env: { COMMONS_EMBED: "true", COMMONS_EMBED_OVERRIDE: override }, port: 5411 }), /COMMONS_EMBED_OVERRIDE: builders.target must be an https URL/);

    const refused = (config: unknown, message: RegExp, env: NodeJS.ProcessEnv = { COMMONS_EMBED: "true" }) =>
      assert.throws(() => e.readEmbed({ env, port: 5001, configText: typeof config === "string" ? config : JSON.stringify(config), packageText }), message);
    const good = { target: "https://github.com/org/repo", kernelSigners: [KALMAN], preset: "phase1", port: 5101 };
    refused("{", /not JSON/);
    refused([], /JSON object/);
    refused({ Builders: good }, /not a community id/);
    refused({ key: good }, /not a community id it can serve/);
    refused({ builders: "x" }, /must be an object/);
    refused({ builders: { ...good, token: "x" } }, /unknown fields token/);
    refused({ builders: { ...good, target: "http://github.com/org/repo" } }, /https URL/);
    refused({ builders: { ...good, target: "https://u:p@github.com/org/repo" } }, /no credentials/);
    refused({ builders: { ...good, target: "https://github.com/org/repo?x" } }, /no credentials, query/);
    refused({ builders: { ...good, target: "https://github.com/" } }, /name a repository/);
    refused({ builders: { ...good, target: "https://github.com/org/repo x" } }, /without spaces/);
    refused({ builders: { ...good, kernelSigners: [] } }, /at least one/);
    refused({ builders: { ...good, kernelSigners: [KALMAN.toUpperCase().replace("0X", "0x")] } }, /not an Anthill user id/);
    refused({ builders: { ...good, kernelSigners: [KALMAN, KALMAN] } }, /twice/);
    refused({ builders: { ...good, preset: "Phase 1" } }, /preset name/);
    refused({ builders: { ...good, rulesPreset: "none" } }, /rulesPreset must be one of phase1, solo/);
    refused({ builders: { ...good, rulesPreset: "Solo" } }, /rulesPreset must be one of/);
    refused({ builders: { ...good, rulesPreset: null } }, /rulesPreset must be one of/);
    // rulesPreset, from the file or a local override
    assert.equal(e.readEmbed({ env: { COMMONS_EMBED: "true" }, port: 5001, configText: JSON.stringify({ builders: { ...good, rulesPreset: "phase1" } }), packageText }).embed!.communities[0].rulesPreset, "phase1");
    assert.equal(e.readEmbed({ env: { COMMONS_EMBED: "true", COMMONS_EMBED_OVERRIDE: JSON.stringify({ builders: { rulesPreset: "solo" } }) }, port: 5411 }).embed!.communities[0].rulesPreset, "solo");
    refused({ builders: { ...good, port: 80 } }, /port from 1024/);
    refused({ builders: { ...good, port: 5001 } }, /already the backend's/);
    refused({ builders: good, others: { ...good } }, /already the backend's or another/);
    refused({ builders: good }, /isn't in commons.config.json/, { COMMONS_EMBED: "true", COMMONS_EMBED_OVERRIDE: JSON.stringify({ other: { preset: "x" } }) });
    assert.throws(() => e.pinnedCommit(JSON.stringify({ dependencies: { "agent-commons": "github:anthill-ai/agent-commons#main" } })), /full 40-character commit/);
    assert.throws(() => e.pinnedCommit(JSON.stringify({ dependencies: { "agent-commons": "github:anthill-ai/agent-commons" } })), /full 40-character commit/);
    assert.throws(() => e.pinnedCommit(JSON.stringify({ dependencies: {} })), /full 40-character commit/);
    assert.ok(configText.length > 0);

    const list = embed.communities;
    assert.ok(e.embeddedPath(list, "/commons/builders"));
    assert.ok(e.embeddedPath(list, "/commons/builders/api/head"));
    assert.ok(!e.embeddedPath(list, "/commons/buildersx"));
    assert.ok(!e.embeddedPath(list, "/commons/key"));
    assert.ok(!e.embeddedPath(list, "/c/builders/commons/pairings"));
  }
  ok("on with RENDER=true or COMMONS_EMBED=true; commons.config.json read strictly; local overrides (ignored on Render); COMMONS_SITES wins; public and internal URLs");

  ////////////////////////////////////////////
  //// the pin and what the child needs

  const checked = e.commonsRuntime(PIN);
  assert.deepEqual(checked.problems, []);
  assert.deepEqual(checked.notes, []);
  const rt = checked.runtime!;
  assert.ok(rt.tsx.startsWith("file://"));
  assert.ok(rt.cli.endsWith(join("agent-commons", "src", "cli.ts")));
  const pinnedPkg = JSON.parse(readFileSync(require.resolve("agent-commons/package.json"), "utf8"));
  assert.deepEqual(Object.keys(pinnedPkg.dependencies ?? {}), [], "the pinned commons has runtime dependencies: install them too");
  {
    const commonsSrc = join(rt.cli, "..");
    const server = readFileSync(join(commonsSrc, "server.ts"), "utf8");
    const limit = (name: string) => {
      const m = new RegExp(`\\n  ${name}: ([0-9 *]+),`).exec(server);
      assert.ok(m, `DEFAULT_LIMITS.${name} in the pinned server.ts`);
      return Function(`return ${m[1]}`)() as number;
    };
    const limits = { entryBytes: limit("entryBytes"), patchBytes: limit("patchBytes"), testBytes: limit("testBytes") };
    assert.equal(Math.max(...Object.values(limits)), e.MAX_PROXY_BODY, `the proxy's cap is the coordinator's largest body (${JSON.stringify(limits)})`);
    assert.ok(server.includes('e === "loopback"'), "the pinned commons trusts loopback as a proxy");
    const help = spawnSync(rt.node, ["--import", rt.tsx, rt.cli, "host", "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    // every flag the backend may pass, pushing included: one the pin doesn't
    // take stops the child before it starts (exit 2, "unknown flag")
    const spec = e.childSpec({ ...(e.readEmbed({ env: { RENDER: "true" }, port: 10000 }).embed!.communities[0]), allowFileTarget: true, rulesPreset: "solo", pushUpstream: true }, { communities: [], commit: PIN, dataDir: "/d", anthillUrl: "http://127.0.0.1:1" }, rt);
    const flags = e.checkSpec(spec).args.filter((a) => a.startsWith("--") && a !== "--import");
    for (const flag of ["--embedded", "--rules-preset", "--push-upstream"]) assert.ok(flags.includes(flag), flag);
    for (const flag of flags) assert.ok(help.stdout.includes(`  ${flag} `) || help.stdout.includes(`  ${flag}\n`), `commons host takes ${flag}`);
    assert.deepEqual(e.checkSpec(spec).args.slice(0, 5), ["--import", rt.tsx, rt.cli, "host", "--check"]);

    // the rules presets taken are the pin's; its solo rules soak an hour
    // (one person sees a merge reach main in the same sitting), and the
    // kit's head passes on the solo mode the coordinator adds
    const pinnedRules = await import("agent-commons/src/rules.ts");
    assert.deepEqual([...e.RULES_PRESETS].sort(), Object.keys(pinnedRules.PRESETS).sort(), "rulesPreset takes exactly the pin's presets");
    assert.equal(pinnedRules.soloRules().promotion.soakFloorHours, 1, "the pinned solo rules soak an hour");
    const { CommonsClient } = await import("agent-commons/src/client.ts");
    const { generateKeyPair } = await import("agent-commons/src/crypto.ts");
    const soloHead = { seq: 3, hash: "h", at: new Date().toISOString(), nextSeq: 4, mode: "solo", notice: "solo test" };
    const headClient = new CommonsClient({ baseUrl: "http://127.0.0.1:1", agentKey: generateKeyPair(), fetch: (async () => Response.json(soloHead)) as never });
    const head = (await headClient.head()) as { mode?: string };
    assert.equal(head.mode, "solo", "the pinned kit's commons-agent head passes on the solo mode");
    for (const role of ["worker", "reviewer", "spec-writer"]) {
      assert.match(readFileSync(join(commonsSrc, "..", "agent-kit", "roles", `${role}.md`), "utf8"), /## Solo mode/, `the pinned ${role}.md says what solo means`);
    }
    // the kit agents install is the coordinator's own commit: a kit older
    // than the coordinator drops what it says (head's solo mode) and its role
    // files miss what it does
    const { DEFAULT_KIT_COMMIT } = await import("../src/commonsAgents");
    assert.equal(DEFAULT_KIT_COMMIT, PIN, "DEFAULT_KIT_COMMIT (the kit agents install) is the pinned agent-commons commit");
  }
  ok("package.json pins one commit, npm installed it, tsx and git are there, the pinned source has what the proxy and the child rely on");

  ////////////////////////////////////////////
  //// the child's command

  {
    const c = e.readEmbed({ env: { RENDER: "true", RENDER_EXTERNAL_URL: "https://b.onrender.com" }, port: 10000 }).embed!;
    const spec = e.childSpec(c.communities[0], { ...c, dataDir: "/var/data" }, rt, {
      PATH: "/usr/bin",
      HOME: "/home/x",
      ADMIN_TOKEN: "secret",
      GOOGLE_CLIENT_SECRET: "secret",
      SESSION_SECRET: "secret",
      ANTHILL_SIGNING_KEY: "secret",
      COMMONS_SITES: "{}",
      COMMONS_BASE_PATH: "/x",
    });
    assert.equal(spec.command, process.execPath);
    assert.equal(spec.cwd, "/var/data/commons/builders");
    assert.deepEqual(spec.env, { PATH: "/usr/bin", HOME: "/home/x" });
    assert.deepEqual(spec.args, [
      "--import", rt.tsx, rt.cli, "host",
      "--data", "/var/data/commons/builders",
      "--host", "127.0.0.1",
      "--port", "5101",
      "--base-path", "/commons/builders",
      "--trusted-proxy", "loopback",
      "--public-url", "https://b.onrender.com/commons/builders",
      "--anthill-url", "http://127.0.0.1:10000",
      "--community", "builders",
      "--target-repo", "https://github.com/anthill-ai/agent-commons",
      "--kernel-signer", KALMAN,
      "--preset", "solo",
      "--embedded",
      "--loop-seconds", "30",
    ]);
    assert.ok(!spec.args.includes("--hold-on-failure"));
    // with a rulesPreset: passed on, so leaving solo needs no shell
    const switching = e.childSpec({ ...c.communities[0], rulesPreset: "phase1" }, { ...c, dataDir: "/var/data" }, rt, {});
    const at = switching.args.indexOf("--rules-preset");
    assert.ok(at > 0 && switching.args[at + 1] === "phase1", JSON.stringify(switching.args));
  }
  ok("the child: commons host on 127.0.0.1 under /commons/<community>, trusting loopback, linked to this backend, without the backend's secrets");

  ////////////////////////////////////////////
  //// the supervisor

  const scratch = mkdtempSync(join(tmpdir(), "anthill-embed-"));
  {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    // exits at once, three times: restarted after 50, 100, 200 ms
    const counter = join(scratch, "count");
    const crashing = new e.Supervisor(
      "crash",
      {
        command: process.execPath,
        args: ["-e", `const fs=require("fs");const n=fs.existsSync(${JSON.stringify(counter)})?Number(fs.readFileSync(${JSON.stringify(counter)},"utf8")):0;fs.writeFileSync(${JSON.stringify(counter)},String(n+1));console.log("run",n);console.error("oops\\u0007");process.exit(n<3?2:0)`],
        cwd: scratch,
        env: {},
      },
      { log, minDelayMs: 50, maxDelayMs: 150, healthyMs: 60_000 },
    );
    const t0 = Date.now();
    crashing.start();
    await until("four runs", 5_000, async () => (crashing.starts >= 5 ? true : undefined));
    await crashing.stop();
    assert.ok(Date.now() - t0 >= 50 + 100 + 150 + 150, "backoff doubles, up to the cap");
    assert.ok(lines.includes("[commons crash] run 0") && lines.includes("[commons crash] run 3"), lines.join("\n"));
    assert.ok(lines.includes("[commons crash] oops"), "control characters dropped");
    assert.ok(lines.includes("[commons crash] exited with code 2"));
    assert.ok(lines.includes("[commons crash] restarting in 0 s"));
    assert.ok(lines.every((l) => l.startsWith("[commons crash] ")));
    const runs = crashing.starts;
    await sleep(400);
    assert.equal(crashing.starts, runs, "not restarted after stop");

    // a command that can't run is retried, and throws nothing
    const missing = new e.Supervisor("missing", { command: join(scratch, "no-such-node"), args: [], cwd: scratch, env: {} }, { log, minDelayMs: 20, maxDelayMs: 20 });
    missing.start();
    await until("two tries", 3_000, async () => (missing.starts >= 2 ? true : undefined));
    await missing.stop();
    assert.ok(lines.some((l) => l.startsWith("[commons missing] could not start:")));

    // stop: SIGTERM to the whole group (a grandchild too); one that ignores
    // it gets SIGKILL after the grace
    const pidFile = join(scratch, "grandchild");
    const stubborn = new e.Supervisor(
      "stubborn",
      {
        command: process.execPath,
        args: [
          "-e",
          `const {spawn}=require("child_process");const g=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});require("fs").writeFileSync(${JSON.stringify(pidFile)},String(g.pid));process.on("SIGTERM",()=>console.log("ignoring SIGTERM"));console.log("up");setInterval(()=>{},1000)`,
        ],
        cwd: scratch,
        env: {},
      },
      { log, stopGraceMs: 300 },
    );
    stubborn.start();
    await until("the child up", 5_000, async () => (lines.includes("[commons stubborn] up") && existsSync(pidFile) ? true : undefined));
    const childPid = stubborn.pid!;
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    assert.ok(pidAlive(childPid) && pidAlive(grandchild));
    await stubborn.stop();
    await until("both gone", 3_000, async () => (!pidAlive(childPid) && !pidAlive(grandchild) ? true : undefined));
    assert.ok(lines.includes("[commons stubborn] ignoring SIGTERM"));
    assert.ok(lines.includes("[commons stubborn] stopped by SIGKILL"));
    assert.equal(stubborn.running, false);
  }
  ok("the supervisor: prefixed log lines, restarts with backoff, a command that can't run retried, stop takes the whole group (SIGKILL after the grace)");

  ////////////////////////////////////////////
  //// what the pinned commons can't start is neither started nor advertised

  {
    const quiet = async <T>(f: () => Promise<T>): Promise<{ value: T; errors: string[] }> => {
      const errors: string[] = [];
      const [err, log, warn] = [console.error, console.log, console.warn];
      console.error = (...args: unknown[]) => void errors.push(args.join(" "));
      console.log = () => {};
      console.warn = () => {};
      try {
        return { value: await f(), errors };
      } finally {
        [console.error, console.log, console.warn] = [err, log, warn];
      }
    };
    const committed = e.readEmbed({ env: { RENDER: "true" }, port: 10000 }).embed!;
    // a preset no pin knows: not started, said why, nothing written
    {
      const dataDir = join(scratch, "refused-data");
      const embed = { ...committed, dataDir, communities: committed.communities.map((c) => ({ ...c, preset: "nonesuch" })) };
      const { value, errors } = await quiet(() => e.startEmbedded(embed, { runtime: rt, shutdown: false }));
      assert.deepEqual(value, [], "not started");
      assert.match(errors.join("\n"), /Agent commons builders: not starting its coordinator: agent-commons [0-9a-f]{12} says it can't start \(.*--preset/);
      assert.equal(e.setUpCheck(embed.communities[0], embed)(), false, "never set up, so never advertised");
      assert.ok(!existsSync(e.ledgerOf(embed.communities[0], embed)));
    }
    // the committed config: whatever the pin can't start is refused the same way
    for (const c of committed.communities) {
      const dataDir = join(scratch, `committed-${c.community}`);
      mkdirSync(join(dataDir, "commons", c.community), { recursive: true });
      const embed = { ...committed, dataDir, communities: [c] };
      const spec = e.childSpec(c, embed, rt);
      const check = spawnSync(spec.command, e.checkSpec(spec).args, { cwd: spec.cwd, env: spec.env, encoding: "utf8" });
      if (check.status === 0) continue;
      const why = `${check.stdout}${check.stderr}`.trim();
      const { value, errors } = await quiet(() => e.startEmbedded(embed, { runtime: rt, shutdown: false }));
      assert.deepEqual(value, [], `${c.community}: the pinned commons can't start it (${why}), so it isn't started`);
      assert.match(errors.join("\n"), new RegExp(`Agent commons ${c.community}: not starting its coordinator`));
      assert.equal(e.setUpCheck(c, embed)(), false);
      note(`${c.community}: agent-commons ${PIN.slice(0, 12)} can't start it (${why}): it isn't started and its community has no commons until a pin that can`);
    }
  }
  ok("a coordinator the pinned commons says can't start (commons host --check) isn't started, and with no ledger isn't advertised");

  ////////////////////////////////////////////
  //// the proxy, against a fake coordinator

  {
    const childPort = await freePort();
    const commons: Parameters<typeof e.mountCommonsProxy>[1][number] = {
      community: "builders",
      target: "https://github.com/org/repo",
      kernelSigners: [KALMAN],
      preset: "phase1",
      port: childPort,
      basePath: "/commons/builders",
      publicUrl: "http://localhost/commons/builders",
      internalUrl: `http://127.0.0.1:${childPort}/commons/builders`,
      allowFileTarget: false,
      pushUpstream: false,
    };
    type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; bytes: number; firstChunkAt: number; endAt: number };
    const seen: Seen[] = [];
    const child = http.createServer((req, res) => {
      const s: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, bytes: 0, firstChunkAt: 0, endAt: 0 };
      seen.push(s);
      req.on("data", (d: Buffer) => {
        if (s.firstChunkAt === 0) s.firstChunkAt = Date.now();
        s.bytes += d.length;
      });
      req.on("end", () => {
        s.endAt = Date.now();
        const url = req.url ?? "";
        if (url === "/commons/builders") {
          res.writeHead(308, { Location: "/commons/builders/", "Content-Length": "0" });
          return res.end();
        }
        if (url === "/commons/builders/") {
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": "default-src 'none'; script-src 'self'",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Set-Cookie": "x=1",
          });
          return res.end('<html><script src="/commons/builders/static/refresh.js"></script></html>');
        }
        if (url === "/commons/builders/api/slow") {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.write('{"part":1');
          setTimeout(() => res.end(',"part2":2}\n'), 600);
          return;
        }
        res.writeHead(201, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ bytes: s.bytes }));
      });
    });
    await new Promise<void>((r) => child.listen(childPort, "127.0.0.1", () => r()));

    // the backend's middleware as App.ts has it
    const app = new Hono();
    app.use("*", securityHeaders());
    app.use("*", corsPolicy(["http://localhost:5173"]));
    app.use("*", e.exceptProxied([commons], bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Request body too large." }, 413) })));
    app.post("/elsewhere", async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
    e.mountCommonsProxy(app, [commons], clientIp);
    const backendPort = await freePort();
    const backend = serve({ fetch: app.fetch, port: backendPort, hostname: "127.0.0.1" });
    await until("the backend", 3_000, async () => ((await fetch(`http://127.0.0.1:${backendPort}/elsewhere`, { method: "POST" })).ok ? true : undefined));
    const at = (path: string) => `http://127.0.0.1:${backendPort}${path}`;

    // the full path and query, the coordinator's status and headers
    seen.length = 0;
    let res = await fetch(at("/commons/builders/api/head?x=1&y=%2F"), {
      headers: { Authorization: "Bearer session", Cookie: "s=1", "X-Forwarded-For": "6.6.6.6, 203.0.113.9", "X-Real-IP": "6.6.6.6", "X-Commons-Key": "k" },
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { bytes: 0 });
    assert.equal(seen[0].url, "/commons/builders/api/head?x=1&y=%2F");
    assert.equal(seen[0].headers["x-forwarded-for"], "203.0.113.9", "the address the backend reads for the client, alone");
    assert.equal(seen[0].headers.authorization, undefined);
    assert.equal(seen[0].headers.cookie, undefined);
    assert.equal(seen[0].headers["x-real-ip"], undefined);
    assert.equal(seen[0].headers["x-commons-key"], "k");
    // never an address the child takes for its proxy (it would count the
    // client as 127.0.0.1, Anthill's own relay)
    for (const [forwarded, expected] of [
      ["127.0.0.1", e.UNPLACED_CLIENT],
      ["6.6.6.6, ::1", e.UNPLACED_CLIENT],
      ["::ffff:127.0.0.2", e.UNPLACED_CLIENT],
      ["0.0.0.0", e.UNPLACED_CLIENT],
      ["not-an-ip", e.UNPLACED_CLIENT],
      ["2001:db8::7", "2001:db8::7"],
      ["::ffff:198.51.100.3", "::ffff:198.51.100.3"],
    ]) {
      seen.length = 0;
      await (await fetch(at("/commons/builders/api/head"), { headers: { "X-Forwarded-For": forwarded } })).arrayBuffer();
      assert.equal(seen[0].headers["x-forwarded-for"], expected, forwarded);
    }
    // nothing forwarded: the backend reads the socket, 127.0.0.1 here
    seen.length = 0;
    await (await fetch(at("/commons/builders/api/head"))).arrayBuffer();
    assert.equal(seen[0].headers["x-forwarded-for"], e.UNPLACED_CLIENT);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("strict-transport-security") ?? "", /max-age/);
    assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin");

    // the playground keeps its own CSP and CORP; no cookies from it
    res = await fetch(at("/commons/builders/"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; script-src 'self'");
    assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(res.headers.get("set-cookie"), null);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(await res.text(), /\/commons\/builders\/static\/refresh\.js/);

    // redirects come back as they are
    res = await fetch(at("/commons/builders"), { redirect: "manual" });
    assert.equal(res.status, 308);
    assert.equal(res.headers.get("location"), "/commons/builders/");

    // HEAD
    res = await fetch(at("/commons/builders/"), { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(seen.at(-1)!.method, "HEAD");

    // a patch bigger than the backend's 64 KB passes, streamed
    const big = Buffer.alloc(900 * 1024, 7);
    res = await fetch(at("/commons/builders/api/patches/abc"), { method: "POST", body: big, headers: { "Content-Type": "application/octet-stream" } });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { bytes: big.length });
    // elsewhere the backend's own limit holds
    res = await fetch(at("/elsewhere"), { method: "POST", body: Buffer.alloc(100 * 1024) });
    assert.equal(res.status, 413);
    // over the coordinator's largest: refused, declared or streamed
    seen.length = 0;
    res = await fetch(at("/commons/builders/api/patches/abc"), { method: "POST", body: Buffer.alloc(e.MAX_PROXY_BODY + 1) });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error, "too-large");
    assert.equal(seen.length, 0, "a declared length over the cap never reaches the coordinator");
    const chunks = (n: number, size: number, gapMs = 0) =>
      new ReadableStream<Uint8Array>({
        async start(ctl) {
          for (let i = 0; i < n; i++) {
            ctl.enqueue(new Uint8Array(size));
            if (gapMs > 0) await sleep(gapMs);
          }
          ctl.close();
        },
      });
    res = await fetch(at("/commons/builders/api/patches/abc"), { method: "POST", body: chunks(20, 64 * 1024), duplex: "half" } as RequestInit);
    assert.equal(res.status, 413);
    // streamed in: the coordinator has the first chunk before the last is sent
    seen.length = 0;
    res = await fetch(at("/commons/builders/api/entries"), { method: "POST", body: chunks(3, 1024, 300), duplex: "half" } as RequestInit);
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { bytes: 3 * 1024 });
    assert.ok(seen[0].endAt - seen[0].firstChunkAt >= 400, "the request body is streamed to the coordinator");
    // and out: the first part arrives before the coordinator ends
    {
      const t0 = Date.now();
      const r = await fetch(at("/commons/builders/api/slow"));
      const reader = r.body!.getReader();
      const first = await reader.read();
      const firstAt = Date.now() - t0;
      let rest = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += Buffer.from(value).toString();
      }
      assert.match(Buffer.from(first.value!).toString(), /^\{"part":1/);
      assert.ok(firstAt < 500, `the answer is streamed (first bytes after ${firstAt} ms)`);
      assert.match(rest, /"part2":2/);
    }

    // the coordinator down: a 503 to retry
    await new Promise<void>((r) => child.close(() => r()));
    child.closeAllConnections();
    res = await fetch(at("/commons/builders/api/head"));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "30");
    assert.equal((await res.json()).error, "unavailable");
    backend.close();
  }
  ok("the proxy: full path, bodies streamed both ways and past 64 KB up to the coordinator's largest, X-Forwarded-For as the backend reads it (never loopback), no sessions or cookies, the coordinator's headers kept with the backend's added, redirects, 503 while it's down");

  ////////////////////////////////////////////
  //// end to end, with the pinned commons

  if (process.argv.includes("--no-e2e")) {
    note("skipped the end-to-end run (--no-e2e)");
  } else {
    await endToEnd(e, rt, scratch);
    ok("end to end: nothing advertised before setup; the pinned commons sets itself up from a local target, serves its API and playground through the proxy, the summary has the public URLs, an approved pairing is relayed to it on 127.0.0.1 and lands in its ledger, and its agent's proposal, approved as a task on the website, is appended by the coordinator");
  }
  rmSync(scratch, { recursive: true, force: true });
  console.log("all embed checks passed");
  // (the rate-limit sweep's timer)
  process.exit(0);
}

function agentKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    // as agent-commons keeps it (pkcs8 DER, base64url)
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
    sign: (message: string) => sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url"),
  };
}

async function endToEnd(e: typeof import("../src/commonsEmbed"), rt: import("../src/commonsEmbed").Runtime, scratch: string) {
  const link = await import("../src/commonsLink");
  const { offchainServer } = await import("../src/offchainApi");
  const { AuthError, origins } = await import("../src/auth");
  const { corsPolicy, securityHeaders } = await import("../src/headers");
  const { NotFoundError, RateLimitError, RelayError } = await import("../src/http");
  const { ActionError } = await import("../src/offchain");

  // a target repository on this disk, with a main branch
  const target = join(scratch, "target-src");
  mkdirSync(target);
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd: target, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-q");
  writeFileSync(join(target, "README.md"), "target\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "first");

  const dataDir = join(scratch, "data");
  process.env.DATA_DIR = dataDir;
  const port = await freePort();
  const childPort = await freePort();

  const app = new Hono();
  app.use("*", securityHeaders());
  app.use("*", corsPolicy(origins));
  app.onError((err, c) => {
    if (err instanceof AuthError) return c.json({ error: err.message, code: err.code }, 401);
    if (err instanceof ActionError) return c.json({ error: err.message, code: err.code }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message || "Not found" }, 404);
    if (err instanceof RelayError) return c.json({ error: err.message, code: err.code }, 502);
    if (err instanceof RateLimitError) return c.json({ error: "rate limited" }, 429);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  // the backend, with builders' coordinator from the committed config and
  // the local overrides: the target on this disk, solo (as committed), a port of its
  // own. The kernel signer is the founder, whose id exists only once they've
  // signed up: set before the child starts (only the child's command uses it).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COMMONS_EMBED: "true",
    COMMONS_EMBED_TEST_FILE_TARGET: "true",
    COMMONS_EMBED_OVERRIDE: JSON.stringify({ builders: { target: `file://${target}`, preset: "solo", port: childPort } }),
  };
  const embed = e.readEmbed({ env, port }).embed!;
  const builders = embed.communities[0];
  assert.equal(builders.internalUrl, `http://127.0.0.1:${childPort}/commons/builders`);
  const { start } = offchainServer(app, () => {}, { embed });
  await start();
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  const at = (path: string) => `http://127.0.0.1:${port}${path}`;
  const call = async (path: string, body?: unknown, token?: string) => {
    const res = await fetch(at(path), {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, headers: res.headers, data, text };
  };
  const expect = (res: { status: number; data: any }, status: number) => {
    assert.equal(res.status, status, JSON.stringify(res.data));
    return res.data;
  };

  const passkey = new SoftPasskey();
  const options = expect(await call("/auth/register/options", { name: "Founder" }), 200);
  const founder = expect(await call("/auth/register/verify", { flowId: options.flowId, response: passkey.create(options.options) }), 200) as { token: string; user: { id: string } };
  expect(await call("/communities", { id: "builders", name: "Builders", visibility: "public", joinPolicy: "open" }, founder.token), 200);
  builders.kernelSigners = [founder.user.id];

  // before the child is up, the proxy answers 503, and the community has no
  // commons yet: nothing advertised that can't be reached
  expect(await call("/commons/builders/api/head"), 503);
  assert.equal(expect(await call("/c/builders"), 200).community.commons, null);
  expect(await call("/c/builders/commons/agent.md"), 404);
  expect(await call("/c/builders/commons/pairings", { modelFamily: "claude", harness: "claude-code" }, founder.token), 404);
  const lines: string[] = [];
  const [supervisor] = await e.startEmbedded(embed, { runtime: rt, shutdown: false, supervisor: { log: (line) => (process.argv.includes("--verbose") ? console.log(line) : lines.push(line)) } });
  try {
    const head = await until("the coordinator's head through the proxy", 120_000, async () => {
      const r = await call("/commons/builders/api/head");
      return r.status === 200 ? r : undefined;
    });
    assert.equal(head.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(typeof head.data.seq, "number");
    // solo, as the committed config: the head says so (the kit passes it on)
    assert.equal(head.data.mode, "solo");
    if (!process.argv.includes("--verbose")) {
      assert.ok(lines.some((l) => l.startsWith("[commons builders] commons host: setup done")), lines.join("\n"));
      assert.ok(lines.every((l) => l.startsWith("[commons builders] ")));
      // --embedded: no COMMONS_SITES line to set (the backend lists the site)
      assert.ok(!lines.some((l) => l.includes("COMMONS_SITES")), lines.join("\n"));
    }
    const data = join(dataDir, "commons", "builders");
    assert.ok(existsSync(join(data, "commons-ledger.jsonl")));
    assert.ok(existsSync(join(data, "target", ".git")));
    // the playground, its script and its own headers, through the proxy
    const page = await call("/commons/builders/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.match(page.text, /<script src="\/commons\/builders\/static\/refresh\.js"><\/script>/);
    const script = await call("/commons/builders/static/refresh.js");
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    const bare = await fetch(at("/commons/builders"), { redirect: "manual" });
    assert.equal(bare.status, 308);
    assert.equal(bare.headers.get("location"), "/commons/builders/");

    // the summary's public URLs
    const summary = expect(await call("/c/builders"), 200).community.commons;
    assert.deepEqual(summary, { coordinator: `http://localhost:${port}/commons/builders`, site: `http://localhost:${port}/commons/builders/`, repo: `file://${target}` });
    const md = await call("/c/builders/commons/agent.md");
    assert.equal(md.status, 200);
    assert.ok(md.text.includes(`http://localhost:${port}/commons/builders`));
    assert.ok(!md.text.includes(`127.0.0.1:${childPort}`), "agents never see the internal address");

    // a pairing, approved: relayed to the child, in its ledger. (The child
    // pins the community's tree on its first pass; until then it may refuse.)
    const agent = agentKey();
    const made = expect(await call("/c/builders/commons/pairings", { modelFamily: "claude", harness: "claude-code" }, founder.token), 200);
    const fields = { agentKey: agent.publicKey, code: made.code, community: "builders", harness: "claude-code", modelFamily: "claude" };
    const { community: _c, ...claim } = { ...fields, proof: agent.sign(link.pairMessage(fields)) };
    expect(await call("/c/builders/commons/pairings/claim", claim), 200);
    const approved = await until("the approval", 60_000, async () => {
      const r = await call(`/c/builders/commons/pairings/${made.id}/approve`, {}, founder.token);
      return r.status === 200 ? r.data : undefined;
    });
    assert.equal(approved.agent.keyId, link.keyIdOf(agent.publicKey));
    const listed = expect(await call("/c/builders/commons/agents", undefined, founder.token), 200);
    assert.deepEqual(
      listed.agents.map((a: any) => [a.keyId, a.active]),
      [[link.keyIdOf(agent.publicKey), true]],
    );
    // straight from the child's ledger too
    const direct = await (await fetch(`${builders.internalUrl}/api/agents?owner=${founder.user.id}`)).json();
    assert.equal(direct.agents[0].keyId, link.keyIdOf(agent.publicKey));
    assert.ok(readFileSync(join(data, "commons-ledger.jsonl"), "utf8").includes(agent.publicKey));

    // the agent proposes work (an entry it signs, through the proxy); the
    // founder, the community's steward, approves it as a task on the
    // website; the backend writes approved-tasks.json in the child's folder,
    // and the coordinator's next pass (every 30 seconds) appends the task
    const { signEntry } = await import("agent-commons/src/ledger.ts");
    const now = expect(await call("/commons/builders/api/head"), 200);
    const proposal = signEntry(
      { seq: now.nextSeq, prev: now.hash },
      { kind: "proposal", id: "p-e2e", title: "Say hello in the README", evidence: [{ kind: "location", file: "README.md", line: 1, note: "no greeting" }] },
      agent,
      new Date().toISOString(),
    );
    expect(await call("/commons/builders/api/entries", proposal), 201);
    const proposals = await until("the proposal on the website", 30_000, async () => {
      const r = await call("/c/builders/commons/proposals", undefined, founder.token);
      return r.status === 200 && r.data.proposals.some((p: any) => p.id === "p-e2e") ? r.data : undefined;
    });
    assert.equal(proposals.canApprove, true);
    assert.deepEqual(proposals.proposals[0].author.owner, { id: founder.user.id, name: "Founder" });
    const approvedTask = expect(await call("/c/builders/commons/proposals/p-e2e/approve", { ring: 2, sizeEstimate: 3, acceptanceTests: ["test/readme.test.ts"] }, founder.token), 200);
    assert.equal(approvedTask.proposal.task.status, "pending");
    assert.equal(JSON.parse(readFileSync(join(data, "approved-tasks.json"), "utf8"))[0].proposalId, "p-e2e");
    const task = await until("the coordinator to append the approved task", 120_000, async () => {
      const r = await (await fetch(`${builders.internalUrl}/api/tasks`)).json();
      return r.tasks.find((t: any) => t.untrusted?.proposalId === "p-e2e");
    });
    assert.deepEqual([task.ring, task.sizeEstimate, task.acceptanceTestPaths, task.specAuthor, task.status], [2, 3, ["test/readme.test.ts"], founder.user.id, "open"]);
    const created = await until("the task as created on the website", 30_000, async () => {
      const r = await call("/c/builders/commons/proposals", undefined, founder.token);
      const p = r.data.proposals?.find((x: any) => x.id === "p-e2e");
      return p?.task?.status === "created" ? p.task : undefined;
    });
    assert.equal(created.id, task.id);
  } catch (err) {
    console.error(lines.join("\n"));
    throw err;
  } finally {
    const pid = supervisor.pid;
    await supervisor.stop();
    if (pid !== undefined) assert.ok(!pidAlive(pid), "the child is stopped");
    server.close();
  }
  // and its port is closed
  await assert.rejects(fetch(`${builders.internalUrl}/api/head`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
