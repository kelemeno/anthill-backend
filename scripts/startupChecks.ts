// Checks of startup and the log that need restarts, run in-process against
// throwaway data dirs (no server needed): requests wait until the log is
// loaded, a torn last line or a missing newline doesn't stop startup (not
// even on a full disk), a failed or half-done write leaves no trace, a fresh
// data dir's commons can be started, client IPs skip Cloudflare's hops,
// sign-ups per IP count only accounts made, and the one-time fixes that move
// Benedek to the commons only run once they can.
//
//   npx tsx scripts/startupChecks.ts

import assert from "node:assert/strict";
import fs, { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AuthError } from "../src/auth";
import { clientIp, NotFoundError, RateLimitError } from "../src/http";
import { ActionError } from "../src/offchain";
import { offchainServer } from "../src/offchainApi";
import { bigintReviver, Store } from "../src/store";
import { SoftPasskey } from "./softPasskey";

const BENEDEK = "0xc689334412b0666069b309dfd658f56b95dbaf5d";

// A server on `dir`, as App.ts sets it up (without the port).
function boot(dir: string) {
  process.env.DATA_DIR = dir;
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof AuthError) return c.json({ error: err.message }, 401);
    if (err instanceof ActionError) return c.json({ error: err.message, code: err.code }, 400);
    if (err instanceof NotFoundError) return c.json({ error: "Not found" }, 404);
    if (err instanceof RateLimitError) return c.json({ error: "rate limited" }, 429);
    return c.json({ error: "internal error" }, 500);
  });
  const { start } = offchainServer(app, () => {});
  const call = async (path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, data: (await res.json()) as any };
  };
  return { start, call };
}

type Server = ReturnType<typeof boot>;

async function register(server: Server, name: string, headers: Record<string, string> = {}) {
  const passkey = new SoftPasskey();
  const options = await server.call("/auth/register/options", { name }, undefined, headers);
  const verified = await server.call(
    "/auth/register/verify",
    { flowId: options.data.flowId, response: passkey.create(options.data.options) },
    undefined,
    headers,
  );
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  return verified.data as { token: string; user: { id: string; name: string } };
}

// everyone in a community's served tree (without the sentinel above the root)
const members = async (server: Server, cid: string) =>
  Object.keys((await server.call(`/c/${cid}/graph`)).data.nodes)
    .filter((id) => id !== "0x0000000000000000000000000000000000000001")
    .sort();

const freshDir = () => mkdtempSync(join(tmpdir(), "anthill-startup-"));

async function main() {
  const dir = freshDir();

  // Until the log is loaded only signing in answers; the rest is 503.
  const first = boot(dir);
  const early = await first.call("/c/demo/graph");
  assert.equal(early.status, 503);
  assert.ok(Number(early.headers.get("Retry-After")) > 0);
  assert.equal((await first.call("/communities")).status, 503);
  assert.equal((await first.call("/auth/login/options", {})).status, 200);
  const alice = await register(first, "Alice");
  const bob = await register(first, "Bob");
  await first.start();
  assert.equal((await first.call("/c/demo/graph")).status, 200);
  console.log("ok: requests wait for the load");

  // A fresh data dir has no COMMONS_FOUNDER account: anyone can start the
  // commons.
  assert.equal((await first.call("/c/commons")).data.community.founder, null);
  const root = await first.call("/c/commons/action", { fn: "joinTreeAsRoot", args: { name: "Alice" } }, alice.token);
  assert.equal(root.status, 200, JSON.stringify(root.data));
  console.log("ok: a fresh commons can be started");

  // A write that fails changes nothing; the next one works.
  const log = join(dir, "log.jsonl");
  const join_ = { fn: "joinTree", args: { name: "Bob", recipient: alice.user.id } };
  chmodSync(log, 0o444);
  assert.equal((await first.call("/c/commons/action", join_, bob.token)).status, 500);
  chmodSync(log, 0o644);
  assert.deepEqual(await members(first, "commons"), [alice.user.id]);
  assert.equal((await first.call("/c/commons/action", join_, bob.token)).status, 200);
  console.log("ok: a failed write is rolled back");

  // Renaming to the same name adds no history step.
  const steps = async (server: Server) => (await server.call("/c/commons/history")).data.steps.length;
  const before = await steps(first);
  assert.equal((await first.call("/name", { name: "Alice" }, alice.token)).status, 200);
  assert.equal(await steps(first), before);
  assert.equal((await first.call("/name", { name: "Alice 2" }, alice.token)).status, 200);
  assert.equal(await steps(first), before + 1);
  console.log("ok: no-op renames");

  // Client IPs: the entry Render's proxy added, past Cloudflare's hops, and
  // not what the client wrote to its left.
  const ipOf = (forwarded: string) =>
    clientIp({ req: { header: (name: string) => (name === "x-forwarded-for" ? forwarded : undefined) } });
  assert.equal(ipOf("203.0.113.9"), "203.0.113.9");
  assert.equal(ipOf("6.6.6.6, 203.0.113.9"), "203.0.113.9");
  assert.equal(ipOf("203.0.113.9, 172.70.1.2"), "203.0.113.9");
  assert.equal(ipOf("6.6.6.6, 2001:db8::1, 2606:4700::1, ::ffff:162.158.0.1"), "2001:db8::1");
  console.log("ok: client IPs");

  // Sign-ups per IP and hour: only accounts made count (not failed tries),
  // with room for a meetup on one network.
  const meetup = { "X-Forwarded-For": "198.51.100.20" };
  for (let i = 0; i < 5; i++) {
    const bad = await first.call("/auth/register/verify", { flowId: "nope", response: { id: "x" } }, undefined, meetup);
    assert.equal(bad.status, 401, JSON.stringify(bad.data));
  }
  for (let i = 0; i < 100; i++) await register(first, `Guest ${i}`, meetup);
  const options = await first.call("/auth/register/options", { name: "One too many" }, undefined, meetup);
  const over = await first.call(
    "/auth/register/verify",
    { flowId: options.data.flowId, response: new SoftPasskey().create(options.data.options) },
    undefined,
    meetup,
  );
  assert.equal(over.status, 429);
  // another network isn't affected
  await register(first, "Elsewhere", { "X-Forwarded-For": "198.51.100.21" });
  console.log("ok: sign-ups per IP");

  // A torn last line (a crash mid-write) is set aside, and startup goes on.
  writeFileSync(log, `${readFileSync(log, "utf8")}{"type":"action","at":"2026`);
  const second = boot(dir);
  await second.start();
  assert.deepEqual(await members(second, "commons"), [alice.user.id, bob.user.id].sort());
  assert.ok(readFileSync(log, "utf8").endsWith("}\n"));
  assert.ok(readdirSync(dir).some((f) => f.startsWith("log.jsonl.torn-")));
  // and a last entry without its newline is kept, the next one on its own line
  writeFileSync(log, `${readFileSync(log, "utf8")}{"type":"migration","at":"2026-01-01T00:00:00.000Z","id":"check"}`);
  const third = boot(dir);
  await third.start();
  assert.equal((await third.call("/c/commons/action", { fn: "leaveTree" }, bob.token)).status, 200);
  const reloaded = new Store(dir);
  assert.ok(reloaded.hasMigration("check"));
  assert.deepEqual(
    readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l, bigintReviver).type)
      .slice(-2),
    ["migration", "action"],
  );
  console.log("ok: torn and unterminated last lines");

  // fs functions replaced for one call (the store reads them at call time)
  function failing<K extends "appendFileSync" | "writeFileSync">(name: K, fake: (typeof fs)[K], run: () => void) {
    const real = fs[name];
    fs[name] = fake;
    syncBuiltinESMExports();
    try {
      run();
    } finally {
      fs[name] = real;
      syncBuiltinESMExports();
    }
  }
  const enospc = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });

  // A write the full disk cut short leaves no bytes behind: the next entry
  // doesn't turn them into a corrupt line mid-log, which would stop startup.
  {
    const store = new Store(dir);
    const append = fs.appendFileSync;
    failing(
      "appendFileSync",
      ((path: string, data: string) => {
        append(path, data.slice(0, 20));
        throw enospc();
      }) as typeof fs.appendFileSync,
      () => assert.throws(() => store.markMigration("cut-short"), /ENOSPC/),
    );
    assert.ok(!store.hasMigration("cut-short"));
    store.markMigration("after-cut");
    const restarted = new Store(dir);
    assert.ok(!restarted.hasMigration("cut-short"));
    assert.ok(restarted.hasMigration("after-cut"));
  }
  // and a torn last line is cut off even when the disk is still full
  writeFileSync(log, `${readFileSync(log, "utf8")}{"type":"migration","at":"20`);
  failing(
    "writeFileSync",
    (() => {
      throw enospc();
    }) as typeof fs.writeFileSync,
    () => assert.ok(new Store(dir).hasMigration("after-cut")),
  );
  assert.ok(readFileSync(log, "utf8").endsWith("}\n"));
  console.log("ok: writes cut short by a full disk");

  // Benedek, in the demo by mistake, moves to the commons once it's started,
  // whatever its join policy, and only then is the fix marked done.
  const fixDir = freshDir();
  {
    const store = new Store(fixDir);
    const seed = JSON.parse(readFileSync("anthillSnapshot.json", "utf8"), bigintReviver).graph;
    store.setSeed(seed);
    const founder = { id: "0x00000000000000000000000000000000000000f0", name: "Founder" };
    store.addPasskey(founder, { id: "f0", userId: founder.id, publicKey: "", counter: 0 });
    store.moveCommons(
      {
        id: "demo",
        name: "Anthill Demo",
        description: "",
        visibility: "public",
        joinPolicy: "invite",
        createdBy: "",
        createdAt: "",
      },
      founder.id,
    );
    store.markMigration("demo-story-1");
    const leaf = Object.values(seed.dict as Record<string, { id: string; recTreeVotes: string[] }>).find(
      (n) => n.recTreeVotes.length === 0,
    )!.id;
    store.appendAction("demo", BENEDEK, { fn: "joinTree", args: { name: "Benedek", recipient: leaf.toLowerCase() } });
  }
  const pending = boot(fixDir);
  await pending.start();
  assert.ok((await members(pending, "demo")).includes(BENEDEK));
  assert.ok(!new Store(fixDir).hasMigration("benedek-to-commons"));
  {
    // the founder starts the commons and closes it
    const store = new Store(fixDir);
    store.appendAction("commons", "0x00000000000000000000000000000000000000f0", {
      fn: "joinTreeAsRoot",
      args: { name: "Founder" },
    });
    store.updateCommunity("commons", {
      name: "Anthill Commons",
      description: "",
      visibility: "public",
      joinPolicy: "closed",
    });
  }
  const moved = boot(fixDir);
  await moved.start();
  assert.ok(!(await members(moved, "demo")).includes(BENEDEK));
  assert.ok((await members(moved, "commons")).includes(BENEDEK));
  assert.equal((await moved.call("/c/commons/graph")).data.nodes[BENEDEK].sentTreeVote, "0x00000000000000000000000000000000000000f0");
  assert.ok(new Store(fixDir).hasMigration("benedek-to-commons"));
  // and it doesn't run again
  const size = readFileSync(join(fixDir, "log.jsonl")).length;
  await boot(fixDir).start();
  assert.equal(readFileSync(join(fixDir, "log.jsonl")).length, size);
  assert.ok(new Store(fixDir).hasMigration("benedek-to-commons-2"));
  console.log("ok: benedek-to-commons");

  // The fix's first version left the demo first and was marked done before
  // the commons was started: the repair puts him in the commons once it is.
  const leftDir = freshDir();
  const founderId = "0x00000000000000000000000000000000000000f0";
  {
    const store = new Store(leftDir);
    const seed = JSON.parse(readFileSync("anthillSnapshot.json", "utf8"), bigintReviver).graph;
    store.setSeed(seed);
    store.addPasskey({ id: founderId, name: "Founder" }, { id: "f0", userId: founderId, publicKey: "", counter: 0 });
    store.moveCommons(
      { id: "demo", name: "Anthill Demo", description: "", visibility: "public", joinPolicy: "invite", createdBy: "", createdAt: "" },
      founderId,
    );
    store.markMigration("demo-story-1");
    const leaf = Object.values(seed.dict as Record<string, { id: string; recTreeVotes: string[] }>).find(
      (n) => n.recTreeVotes.length === 0,
    )!.id;
    store.appendAction("demo", BENEDEK, { fn: "joinTree", args: { name: "Benedek", recipient: leaf.toLowerCase() } });
    store.markMigration("benedek-to-commons");
    store.appendAction("demo", BENEDEK, { fn: "leaveTree", args: {} });
  }
  await boot(leftDir).start();
  assert.ok(!new Store(leftDir).hasMigration("benedek-to-commons-2"));
  new Store(leftDir).appendAction("commons", founderId, { fn: "joinTreeAsRoot", args: { name: "Founder" } });
  const repaired = boot(leftDir);
  await repaired.start();
  assert.deepEqual(await members(repaired, "commons"), [founderId, BENEDEK].sort());
  assert.ok(!(await members(repaired, "demo")).includes(BENEDEK));
  assert.ok(new Store(leftDir).hasMigration("benedek-to-commons-2"));
  console.log("ok: benedek-to-commons-2");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
