// Checks of the agent commons coordinators this backend runs itself
// (src/commonsEmbed.ts), with nothing on the network but localhost:
// - the config: when it's on (Render, COMMONS_EMBED), the committed
//   commons.config.json, strict refusals, the local overrides (ignored on
//   Render), COMMONS_SITES winning, the public and internal URLs;
// - the pin: package.json names one exact commit, npm installed that one,
//   tsx and git are there, and the pinned source still has what this relies
//   on (its largest body is the proxy's cap, `commons host` takes every flag
//   passed, loopback as a trusted proxy); whether it knows the config's
//   preset yet is reported, not required (a later pin bump makes it valid);
// - the child's command line and environment (no backend secrets);
// - the supervisor: log prefix, restarts with backoff, a spawn that fails,
//   stop (SIGTERM, SIGKILL after the grace, the whole process group);
// - the proxy, against a fake coordinator: the full path, bodies streamed
//   both ways and bigger than the backend's 64 KB (up to the coordinator's
//   own largest, then a 413), X-Forwarded-For as the backend reads the
//   client, no sessions or cookies passed on, the coordinator's own headers
//   with the backend's security headers where it set none, redirects passed
//   back, a 503 while the child is down, the backend's own limits unchanged
//   elsewhere;
// - end to end with the pinned commons itself (skip with --no-e2e): a
//   backend on a fresh data dir with a public builders community, its
//   coordinator set up from a local target repository (the test-only file:
//   flag) with the founder as kernel signer, serving through the proxy (the
//   API's head, the playground and its script), the community summary's
//   public URLs, an Agents pairing whose approval is relayed to the child on
//   127.0.0.1 and lands in its ledger, and the child stopped at the end.
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
    assert.deepEqual(onRender.notes, []);
    const embed = onRender.embed!;
    assert.equal(embed.commit, PIN);
    assert.equal(embed.dataDir, "/var/data");
    assert.equal(embed.anthillUrl, "http://127.0.0.1:10000");
    assert.deepEqual(embed.communities, [
      {
        community: "builders",
        target: "https://github.com/kelemeno/agent-commons",
        kernelSigners: [KALMAN],
        preset: "solo",
        port: 5101,
        basePath: "/commons/builders",
        publicUrl: "https://anthill-backend.onrender.com/commons/builders",
        internalUrl: "http://127.0.0.1:5101/commons/builders",
        allowFileTarget: false,
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
    refused({ builders: { ...good, port: 80 } }, /port from 1024/);
    refused({ builders: { ...good, port: 5001 } }, /already the backend's/);
    refused({ builders: good, others: { ...good } }, /already the backend's or another/);
    refused({ builders: good }, /isn't in commons.config.json/, { COMMONS_EMBED: "true", COMMONS_EMBED_OVERRIDE: JSON.stringify({ other: { preset: "x" } }) });
    assert.throws(() => e.pinnedCommit(JSON.stringify({ dependencies: { "agent-commons": "github:kelemeno/agent-commons#main" } })), /full 40-character commit/);
    assert.throws(() => e.pinnedCommit(JSON.stringify({ dependencies: { "agent-commons": "github:kelemeno/agent-commons" } })), /full 40-character commit/);
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
    const spec = e.childSpec({ ...(e.readEmbed({ env: { RENDER: "true" }, port: 10000 }).embed!.communities[0]), allowFileTarget: true }, { communities: [], commit: PIN, dataDir: "/d", anthillUrl: "http://127.0.0.1:1" }, rt);
    for (const flag of spec.args.filter((a) => a.startsWith("--") && a !== "--import")) assert.ok(help.stdout.includes(`  ${flag} `) || help.stdout.includes(`  ${flag}\n`), `commons host takes ${flag}`);
    // which presets it knows: the config's may need a later pin
    const presets = /--preset <value>\s+setup: ([^(]+)\(/.exec(help.stdout)?.[1] ?? "";
    for (const c of e.readEmbed({ env: { RENDER: "true" }, port: 10000 }).embed!.communities) {
      if (!new RegExp(`\\b${c.preset}\\b`).test(presets)) {
        note(`the pinned agent-commons (${PIN.slice(0, 12)}) doesn't know preset "${c.preset}" (${c.community}) yet: its child will exit 2 and be restarted with backoff until a pin that knows it`);
      }
    }
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
      "--target-repo", "https://github.com/kelemeno/agent-commons",
      "--kernel-signer", KALMAN,
      "--preset", "solo",
      "--loop-seconds", "30",
    ]);
    assert.ok(!spec.args.includes("--hold-on-failure"));
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
  ok("the proxy: full path, bodies streamed both ways and past 64 KB up to the coordinator's largest, X-Forwarded-For as the backend reads it, no sessions or cookies, the coordinator's headers kept with the backend's added, redirects, 503 while it's down");

  ////////////////////////////////////////////
  //// end to end, with the pinned commons

  if (process.argv.includes("--no-e2e")) {
    note("skipped the end-to-end run (--no-e2e)");
  } else {
    await endToEnd(e, rt, scratch);
    ok("end to end: the pinned commons sets itself up from a local target, serves its API and playground through the proxy, the summary has the public URLs, and an approved pairing is relayed to it on 127.0.0.1 and lands in its ledger");
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
  // the local overrides: the target on this disk, phase1, a port of its
  // own. The kernel signer is the founder, whose id exists only once they've
  // signed up: set before the child starts (only the child's command uses it).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COMMONS_EMBED: "true",
    COMMONS_EMBED_TEST_FILE_TARGET: "true",
    COMMONS_EMBED_OVERRIDE: JSON.stringify({ builders: { target: `file://${target}`, preset: "phase1", port: childPort } }),
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

  // before the child is up, the proxy answers 503
  expect(await call("/commons/builders/api/head"), 503);
  const lines: string[] = [];
  const [supervisor] = e.startEmbedded(embed, { runtime: rt, shutdown: false, supervisor: { log: (line) => (process.argv.includes("--verbose") ? console.log(line) : lines.push(line)) } });
  try {
    const head = await until("the coordinator's head through the proxy", 120_000, async () => {
      const r = await call("/commons/builders/api/head");
      return r.status === 200 ? r : undefined;
    });
    assert.equal(head.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(typeof head.data.seq, "number");
    if (!process.argv.includes("--verbose")) {
      assert.ok(lines.some((l) => l.startsWith("[commons builders] commons host: setup done")), lines.join("\n"));
      assert.ok(lines.every((l) => l.startsWith("[commons builders] ")));
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
