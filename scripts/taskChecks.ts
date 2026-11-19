// Checks of approving agents' proposals as tasks from the website
// (src/commonsTasks.ts), in-process on a throwaway data dir, against a fake
// coordinator API (nothing on the network: its answers come from a ledger
// built here with the pinned agent-commons' own code, linked to the
// community and signed by this backend's key, as a hosted one is):
// - the task rules here are the pinned ledger's (its limits, id rule and
//   canonical paths, its claim stake), and every approval taken here is a
//   task entry the pinned ledger accepts; the task id is the same each time
//   and names a ref; acceptance test paths are exact files, never globs the
//   pinned coordinator would expand (a crafted one hangs it);
// - sizes: at most what the ledger's rules let be submitted at once and
//   claimed, read from the ledger (its rulesChanges too), and told to the
//   steward with what's needed to show a claim stake;
// - 404 for a community without a commons, with the operator's commons
//   elsewhere (COMMONS_SITES), with one not set up yet, and for who can't see
//   a private one;
// - the list: newest first, a page at a time, with what waits on the
//   coordinator always on the first page (a flood of proposals can't push
//   it out of reach), a few pieces of evidence each (all of them for one),
//   evidence in words, the author's agent and owner,
//   read through the API page by page, reused for a few seconds, then topped
//   up from where it left off; another ledger (a fresh disk) is read again
//   from the start; a long one is read over several asks, and nothing is
//   approved until it's all read; the coordinator down is a 502;
// - approving: signed in, the steward only, every field held to the
//   ledger's rules (refused: nothing written), the spec author an owner
//   (you by default), an unknown proposal, one that's a task already; the
//   file written whole (0600, no temporary file left), exactly the task
//   body, once per proposal; the coordinator's own planner then appends it,
//   once, and it shows as created; parallel approvals all land; entries
//   written by hand are kept, and ones already on the ledger dropped; a
//   file that isn't a JSON array is never overwritten;
// - declining takes a pending approval out, and a task can't be declined; a
//   decline that loses the race to a coordinator pass is watched, and shows
//   as created once the task lands;
// - both rate limited.
//
//   npx tsx scripts/taskChecks.ts

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SoftPasskey } from "./softPasskey";

process.env.RP_ID = "localhost";
process.env.ORIGINS = "http://localhost:5173";
process.env.SEED = "empty";
for (const name of ["SESSION_SECRET", "GOOGLE_CLIENT_ID", "PUBLIC_URL", "RENDER_EXTERNAL_URL", "COMMONS_KIT_COMMIT", "RENDER", "COMMONS_EMBED", "ANTHILL_SIGNING_KEY"]) {
  delete process.env[name];
}
const REMOTE = "https://remote-coordinator.test";
process.env.COMMONS_SITES = JSON.stringify({ remote: { coordinator: REMOTE, site: REMOTE } });

const ok = (name: string) => console.log(`ok: ${name}`);
// The clock, moved on (rate-limit windows and the read cache)
const realNow = Date.now;
let skipped = 0;
const nextMinute = () => {
  skipped += 61_000;
  Date.now = () => realNow() + skipped;
};
const later = (ms: number) => {
  skipped += ms;
  Date.now = () => realNow() + skipped;
};

async function main() {
  const tasks = await import("../src/commonsTasks");
  const e = await import("../src/commonsEmbed");
  const link = await import("../src/commonsLink");
  const { offchainServer } = await import("../src/offchainApi");
  const { AuthError, origins } = await import("../src/auth");
  const { corsPolicy, securityHeaders } = await import("../src/headers");
  const { NotFoundError, RateLimitError, RelayError } = await import("../src/http");
  const { ActionError } = await import("../src/offchain");
  // the pinned agent-commons
  const ledger = await import("agent-commons/src/ledger.ts");
  const crypto = await import("agent-commons/src/crypto.ts");
  const rules = await import("agent-commons/src/rules.ts");
  const coordinator = await import("agent-commons/src/coordinator.ts");

  ////////////////////////////////////////////
  //// the rules are the pinned ledger's

  assert.equal(tasks.TASK_LIMITS.id, ledger.LEDGER_LIMITS.id);
  assert.equal(tasks.TASK_LIMITS.path, ledger.LEDGER_LIMITS.path);
  assert.equal(tasks.TASK_LIMITS.acceptanceTestPaths, ledger.LEDGER_LIMITS.acceptanceTestPaths);
  assert.equal(tasks.TASK_LIMITS.title, ledger.LEDGER_LIMITS.title);
  assert.equal(tasks.TASK_LIMITS.evidence, ledger.LEDGER_LIMITS.evidence);
  assert.equal(tasks.LEDGER_ID.source, ledger.ID_RE.source);
  const paths = ["a", "test/a.test.ts", "a/b/c", "./a", "a/./b", "a/../b", "../a", "/a", "a/", "a//b", "a\\b", "a\0b", "", ".", "..", "...", "a b/c d", ".hidden/x", "x".repeat(512), "x".repeat(513), 7, null];
  for (const p of paths) assert.equal(tasks.isCanonicalPath(p), ledger.isCanonicalPath(p), JSON.stringify(p));
  // the claim stake is the pinned ledger's, and the kit's default limit
  const client = await import("agent-commons/src/client.ts");
  assert.equal(tasks.AGENT_MAX_STAKE, client.DEFAULT_MAX_STAKE);
  for (const r of [rules.soloRules(), rules.defaultRules(), rules.phase1Rules(rules.defaultRules())]) {
    const sr = tasks.sizeRulesOf(r)!;
    assert.ok(sr, "the size rules read from the pinned rules");
    for (const ring of [0, 1, 2] as const) {
      for (const n of [0, 1, 50, 99, 100, 101, 399, 400, 401, 700, 1345, 5000]) assert.equal(tasks.claimStakeFor(n, ring, sr), Math.max(1, rules.claimStake(n, ring, r)), `${n} lines, ring ${ring}`);
      // the largest size: submittable, and claimable within what an agent locks
      const max = tasks.maxSizeFor(ring, sr);
      assert.ok(max >= 0 && max <= r.maxLinesPerSubmission, String(max));
      assert.ok(rules.claimStake(max, ring, r) <= Math.min(r.stake.allowance, client.DEFAULT_MAX_STAKE));
      assert.ok(max === r.maxLinesPerSubmission || rules.claimStake(max + 1, ring, r) > Math.min(r.stake.allowance, client.DEFAULT_MAX_STAKE));
    }
  }
  // solo: 400 lines a submission, and a ring-0 task of 400 lines is claimable (stake 320)
  assert.deepEqual(tasks.sizeLimits(tasks.sizeRulesOf(rules.soloRules())!).maxSizeEstimate, [400, 400, 400]);
  assert.equal(tasks.sizeRulesOf({ maxLinesPerSubmission: 1 }), undefined);
  assert.equal(tasks.sizeRulesOf(null), undefined);
  const tid = tasks.taskIdFor("p-1");
  assert.match(tid, /^t-[0-9a-f]{16}$/);
  assert.equal(tasks.taskIdFor("p-1"), tid);
  assert.notEqual(tasks.taskIdFor("p-2"), tid);
  assert.ok(ledger.ID_RE.test(tid) && ledger.isRefSafeId(tid));
  ok("the task rules here are the pinned ledger's; the task id is the same each time, and names a ref");

  // what the approval form takes, field by field
  const approver = `0x${"a".repeat(40)}`;
  const good = { ring: 1, sizeEstimate: 40, acceptanceTests: ["test/a.test.ts"] };
  assert.deepEqual(tasks.parseApproval(good, approver), { ring: 1, sizeEstimate: 40, acceptanceTestPaths: ["test/a.test.ts"], specAuthor: approver });
  assert.equal(tasks.parseApproval({ ...good, specAuthor: `0x${"b".repeat(40)}` }, approver).specAuthor, `0x${"b".repeat(40)}`);
  assert.equal(tasks.parseApproval({ ...good, ring: 0, sizeEstimate: 0 }, approver).ring, 0);
  assert.equal(tasks.parseApproval({ ...good, sizeEstimate: tasks.MAX_SIZE_ESTIMATE }, approver).sizeEstimate, tasks.MAX_SIZE_ESTIMATE);
  assert.equal(tasks.parseApproval({ ...good, acceptanceTests: Array.from({ length: 100 }, (_, i) => `t/${i}.ts`) }, approver).acceptanceTestPaths.length, 100);
  const refusals: [object, RegExp][] = [
    [{ ...good, ring: 3 }, /ring/],
    [{ ...good, ring: "1" }, /ring/],
    [{ ...good, ring: 1.5 }, /ring/],
    [{ sizeEstimate: 1, acceptanceTests: ["a"] }, /ring/],
    [{ ...good, sizeEstimate: -1 }, /sizeEstimate/],
    [{ ...good, sizeEstimate: 1.5 }, /sizeEstimate/],
    [{ ...good, sizeEstimate: "40" }, /sizeEstimate/],
    [{ ...good, sizeEstimate: tasks.MAX_SIZE_ESTIMATE + 1 }, /sizeEstimate/],
    [{ ...good, sizeEstimate: Number.NaN }, /sizeEstimate/],
    [{ ring: 1, acceptanceTests: ["a"] }, /sizeEstimate/],
    [{ ...good, acceptanceTests: [] }, /at least one/],
    [{ ...good, acceptanceTests: "test/a.test.ts" }, /at least one/],
    [{ ...good, acceptanceTests: Array.from({ length: 101 }, (_, i) => `t/${i}.ts`) }, /at most 100/],
    [{ ...good, acceptanceTests: ["../a"] }, /isn't a test file path/],
    [{ ...good, acceptanceTests: ["/abs"] }, /isn't a test file path/],
    [{ ...good, acceptanceTests: ["a//b"] }, /isn't a test file path/],
    [{ ...good, acceptanceTests: ["a\\b"] }, /isn't a test file path/],
    [{ ...good, acceptanceTests: ["a\nb"] }, /isn't a test file path/],
    [{ ...good, acceptanceTests: [7] }, /isn't a test file path/],
    [{ ...good, acceptanceTests: ["x".repeat(513)] }, /isn't a test file path/],
    [{ ...good, acceptanceTests: ["a", "a"] }, /twice/],
    // wildcards: the pinned coordinator expands them as globs, and `**/`
    // repeated backtracks for hours in its gates (its HTTP process stops)
    [{ ...good, acceptanceTests: [`${"**/".repeat(16)}x.test.ts`] }, /without wildcards/],
    [{ ...good, acceptanceTests: ["test/*.test.ts"] }, /without wildcards/],
    [{ ...good, acceptanceTests: ["test/**"] }, /without wildcards/],
    [{ ...good, acceptanceTests: ["test/a?.test.ts"] }, /without wildcards/],
    [{ ...good, acceptanceTests: ["test/ok.test.ts", "src/*"] }, /without wildcards/],
    [{ ...good, specAuthor: "Ada" }, /specAuthor/],
    [{ ...good, specAuthor: `0x${"A".repeat(40)}` }, /specAuthor/],
    [{ ...good, specAuthor: null }, /specAuthor/],
    [{ ...good, kind: "task" }, /Unknown fields: kind/],
    [{ ...good, acceptanceTestPaths: ["a"] }, /Unknown fields: acceptanceTestPaths/],
  ];
  for (const [body, message] of refusals) assert.throws(() => tasks.parseApproval(body as Record<string, unknown>, approver), (err: Error) => err instanceof ActionError && message.test(err.message), JSON.stringify(body));
  // what's taken is literal to the pinned coordinator: each path, read as
  // its glob, matches only itself (and what's under it, as a directory)
  const literal = ["test/a.test.ts", "a+b/c(1).spec.ts", "x/[y].ts", "{a,b}.ts", "a.b/c$^|.ts", "dir/tests"];
  for (const p of literal) {
    assert.deepEqual(tasks.parseApproval({ ...good, acceptanceTests: [p] }, approver).acceptanceTestPaths, [p]);
    const re = rules.globToRegExp(p);
    assert.ok(re.test(p), p);
    for (const other of [`${p}x`, `x${p}`, p.replace(/.$/, "_"), `a/${p}`]) assert.ok(!re.test(other), `${p} matches only itself, not ${other}`);
    assert.ok(!/\.\*|\[\^\/\]/.test(re.source), `${p} has no wildcard as the pinned glob: ${re.source}`);
  }
  ok("an approval is held to the ledger's rules for a task, field by field, and nothing else is taken; test paths are exact files, never globs");

  ////////////////////////////////////////////
  //// a ledger linked to the community, built with the pinned code

  const dir = mkdtempSync(join(tmpdir(), "anthill-tasks-"));
  process.env.DATA_DIR = dir;
  // this backend's key, as offchainServer will load it from the data dir
  const anthill = new link.CommonsSigner(dir);
  type Key = { publicKey: string; privateKey: string };
  let entries: any[] = [];
  let state: any;
  let coordKey: Key;
  let admin: Key;
  const iso = () => new Date(realNow()).toISOString();
  function genesis() {
    admin = crypto.generateKeyPair();
    coordKey = crypto.generateKeyPair();
    const g = ledger.genesisEntry(
      { kind: "genesis", project: "builders", admins: [admin.publicKey], coordinator: coordKey.publicKey, rules: rules.soloRules(), anthill: { community: "builders", publicKey: anthill.publicKey } },
      iso(),
    );
    entries = [g];
    state = ledger.replay(entries);
  }
  function append(body: any, signer: Key) {
    const entry = ledger.signEntry(state, body, signer, iso());
    ledger.applyEntry(state, entry);
    entries.push(entry);
    return entry;
  }
  // a member's agent, vouched for by Anthill and relayed by the coordinator
  function agentOf(user: string, modelFamily = "claude") {
    const key = crypto.generateKeyPair();
    append({ kind: "anthillAgent", ...anthill.agent({ agentKey: key.publicKey, at: iso(), community: "builders", harness: "claude-code", modelFamily, user }) }, coordKey);
    return key;
  }
  const propose = (agent: Key, id: string, title: string, evidence: any[]) => append({ kind: "proposal", id, title, evidence }, agent);

  // The coordinator's API, as the pinned server answers: /api/entries (since
  // inclusive, a page of at most `pageSize` here, so reads take several) and
  // /api/tasks.
  const fake = {
    down: false,
    pageSize: 3,
    gets: [] as string[],
  };
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    assert.equal(url.origin, "http://127.0.0.1:5111");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.method ?? "GET", "GET");
    fake.gets.push(`${url.pathname}${url.search}`);
    if (fake.down) throw new TypeError("fetch failed");
    if (url.pathname === "/commons/builders/api/entries") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const limit = Math.min(fake.pageSize, Number(url.searchParams.get("limit") ?? 500));
      const page = entries.slice(since, since + limit);
      const next = since + page.length < entries.length ? since + page.length : null;
      return Response.json({ head: { seq: entries.length - 1, hash: entries.at(-1).hash }, since, limit, next, cursor: "since is inclusive", entries: page });
    }
    if (url.pathname === "/commons/builders/api/tasks") {
      return Response.json({
        tasks: [...state.tasks.values()].map((t: any) => ({ id: t.id, ring: t.ring, status: "open", untrusted: { proposalId: t.proposalId } })),
      });
    }
    return Response.json({ error: "not-found", message: "no route" }, { status: 404 });
  };

  ////////////////////////////////////////////
  //// the server

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COMMONS_EMBED: "true",
    COMMONS_EMBED_OVERRIDE: JSON.stringify({ builders: { port: 5111 } }),
  };
  const configText = JSON.stringify({
    builders: { target: "https://github.com/example/target", kernelSigners: [approver], preset: "solo", port: 5101 },
    later: { target: "https://github.com/example/later", kernelSigners: [approver], preset: "solo", port: 5102 },
    remote: { target: "https://github.com/example/remote", kernelSigners: [approver], preset: "solo", port: 5103 },
  });
  const { embed } = e.readEmbed({ env, port: 5110, configText, sites: new Set(["remote"]) });
  assert.deepEqual(embed!.communities.map((c) => c.community), ["builders", "later"]);
  const builders = embed!.communities[0];
  const file = tasks.approvedTasksPath(builders, embed!);
  assert.equal(file, join(dir, "commons", "builders", "approved-tasks.json"));

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
  const { start } = offchainServer(app, () => {}, { fetch: fetchFn, embed: embed! });
  await start();
  const call = async (path: string, body?: unknown, token?: string) => {
    const res = await app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, data };
  };
  const expect = (res: { status: number; data: any }, status: number, code?: string) => {
    assert.equal(res.status, status, JSON.stringify(res.data));
    if (code !== undefined) assert.equal(res.data.code, code, JSON.stringify(res.data));
    return res.data;
  };
  async function register(name: string) {
    const passkey = new SoftPasskey();
    const options = await call("/auth/register/options", { name });
    return expect(await call("/auth/register/verify", { flowId: options.data.flowId, response: passkey.create(options.data.options) }), 200) as { token: string; user: { id: string; name: string } };
  }
  assert.equal(expect(await call("/commons/key"), 200).publicKey, anthill.publicKey);
  const founder = await register("Founder");
  const mira = await register("Mira");
  const otto = await register("Otto");
  for (const id of ["builders", "later", "remote", "plain"]) {
    expect(await call("/communities", { id, name: id, visibility: "public", joinPolicy: "open" }, founder.token), 200);
  }
  expect(await call("/communities", { id: "secret", name: "Secret", visibility: "private", joinPolicy: "invite" }, founder.token), 200);
  expect(await call("/c/builders/action", { fn: "joinTree", args: { name: "Mira", recipient: founder.user.id } }, mira.token), 200);

  // the commons: Founder's and Mira's agents, three proposals (one a task
  // already, made with the CLI)
  genesis();
  const founderAgent = agentOf(founder.user.id);
  const miraAgent = agentOf(mira.user.id, "gpt");
  propose(founderAgent, "p-1", "Fix the\tflaky\nlogin test", [
    { kind: "failingTest", testId: "login", command: "npm test -- login" },
    { kind: "location", file: "src/auth.ts", line: 12, note: "races the timer" },
  ]);
  propose(miraAgent, "p-2", "Lint warning", [{ kind: "diagnostic", tool: "biome", message: "unused import", file: "src/a.ts", line: 3 }]);
  propose(miraAgent, "p-old", "Already planned", [{ kind: "location", file: "README.md", line: 1, note: "typo" }]);
  append({ kind: "task", id: "t-cli", proposalId: "p-old", ring: 2, acceptanceTestPaths: ["test/readme.test.ts"], sizeEstimate: 5, specAuthor: mira.user.id }, coordKey);

  ////////////////////////////////////////////
  //// where there's no commons of this backend's

  const builderData = join(dir, "commons", "builders");
  // not set up yet (no ledger on the disk): no commons, as everywhere else
  expect(await call("/c/builders/commons/proposals"), 404);
  mkdirSync(builderData, { recursive: true });
  writeFileSync(join(builderData, "commons-ledger.jsonl"), "");
  expect(await call("/c/plain/commons/proposals"), 404);
  expect(await call("/c/later/commons/proposals"), 404);
  expect(await call("/c/remote/commons/proposals"), 404);
  expect(await call("/c/secret/commons/proposals", undefined, otto.token), 404);
  expect(await call("/c/nowhere/commons/proposals"), 404);
  expect(await call("/c/remote/commons/proposals/p-1/approve", good, founder.token), 404);
  expect(await call("/c/plain/commons/proposals/p-1/decline", {}, founder.token), 404);
  assert.deepEqual(fake.gets, []);
  ok("404 without a commons of this backend's: none, the operator's elsewhere, one not set up, a private one you can't see");

  ////////////////////////////////////////////
  //// the list

  {
    const listed = expect(await call("/c/builders/commons/proposals"), 200);
    assert.equal(listed.total, 3);
    assert.equal(listed.canApprove, false);
    assert.equal(listed.owners, undefined);
    assert.deepEqual(listed.proposals.map((p: any) => p.id), ["p-old", "p-2", "p-1"]);
    const [old, p2, p1] = listed.proposals;
    assert.equal(p1.title, "Fix the flaky login test");
    assert.deepEqual(p1.evidence, [
      { kind: "failingTest", text: "login fails: npm test -- login" },
      { kind: "location", text: "src/auth.ts:12: races the timer" },
    ]);
    assert.deepEqual(p1.author, { agent: link.keyIdOf(founderAgent.publicKey), modelFamily: "claude", owner: { id: founder.user.id, name: "Founder" } });
    assert.match(p1.proposedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(p1.task, null);
    assert.equal(p1.evidenceTotal, 2);
    assert.equal(p1.watchUntil, undefined);
    assert.equal(listed.next, null);
    assert.deepEqual(p2.evidence, [{ kind: "diagnostic", text: "biome at src/a.ts:3: unused import" }]);
    assert.deepEqual(p2.author.owner, { id: mira.user.id, name: "Mira" });
    assert.deepEqual(old.task, { status: "created", id: "t-cli", ring: 2, sizeEstimate: 5, acceptanceTestPaths: ["test/readme.test.ts"], specAuthor: { id: mira.user.id, name: "Mira" }, state: "open" });
    // read page by page (3 entries a page here), then the tasks
    const pages = fake.gets.filter((g) => g.includes("/api/entries"));
    assert.equal(pages.length, Math.ceil(entries.length / 3));
    assert.equal(pages[0], "/commons/builders/api/entries?since=0&limit=500");
    assert.equal(fake.gets.at(-1), "/commons/builders/api/tasks");

    // the steward also gets who can be a spec author
    const steward = expect(await call("/c/builders/commons/proposals", undefined, founder.token), 200);
    assert.equal(steward.canApprove, true);
    assert.equal(steward.youAreOwner, true);
    // the sizes a task can have here (solo: 400 lines a submission), and what
    // shows a claim stake beside the field
    assert.deepEqual(steward.sizeLimits, { maxSizeEstimate: [400, 400, 400], maxLinesPerSubmission: 400, stakeLimit: 320, claimStake: { base: 10, exponent: 1.5, ringMultiplier: [4, 1.5, 1] } });
    assert.equal(listed.sizeLimits, undefined);
    assert.deepEqual(steward.owners, [{ id: founder.user.id, name: "Founder" }, { id: mira.user.id, name: "Mira" }].sort((a, b) => a.name.localeCompare(b.name)));
    // a member who isn't the steward: read only
    const member = expect(await call("/c/builders/commons/proposals", undefined, mira.token), 200);
    assert.equal(member.canApprove, false);
    assert.equal(member.owners, undefined);
    // all three within a few seconds: one read
    assert.equal(fake.gets.length, pages.length + 1);

    // later, a new proposal: read from the last entry read on, not again
    later(tasks.VIEW_CACHE_MS + 1);
    propose(founderAgent, "p-3", "Add a test", [{ kind: "failingTest", testId: "x", command: "npm test" }]);
    const before = fake.gets.length;
    const topped = expect(await call("/c/builders/commons/proposals"), 200);
    assert.deepEqual(topped.proposals.map((p: any) => p.id), ["p-3", "p-old", "p-2", "p-1"]);
    assert.deepEqual(fake.gets.slice(before), [`/commons/builders/api/entries?since=${entries.length - 2}&limit=500`, "/commons/builders/api/tasks"]);
  }
  ok("the list: newest first, evidence in words, the author's agent and owner; the steward told the sizes a task can have; read page by page, reused, then topped up");

  ////////////////////////////////////////////
  //// approving

  const approvePath = (id: string) => `/c/builders/commons/proposals/${encodeURIComponent(id)}/approve`;
  const declinePath = (id: string) => `/c/builders/commons/proposals/${encodeURIComponent(id)}/decline`;
  expect(await call(approvePath("p-1"), good), 401);
  expect(await call(approvePath("p-1"), good, mira.token), 400, "not steward");
  expect(await call(declinePath("p-1"), {}, mira.token), 400, "not steward");
  expect(await call(approvePath("p-1"), { ...good, ring: 7 }, founder.token), 400);
  expect(await call(approvePath("p-1"), { ...good, acceptanceTests: ["../etc/passwd"] }, founder.token), 400);
  expect(await call(approvePath("p-1"), "[1]", founder.token), 400);
  expect(await call(approvePath("p-1"), "not json", founder.token), 400);
  expect(await call(approvePath("p-1"), { ...good, specAuthor: otto.user.id }, founder.token), 400, "not-an-owner");
  expect(await call(approvePath("nope"), good, founder.token), 400);
  expect(await call(approvePath("bad id!"), good, founder.token), 400);
  expect(await call(approvePath("p-old"), good, founder.token), 400, "already-a-task");
  // a wildcard path, through the route too
  expect(await call(approvePath("p-1"), { ...good, acceptanceTests: [`${"**/".repeat(16)}x.test.ts`] }, founder.token), 400);
  // sizes the ledger's rules can't do: more than one submission takes, or a
  // claim stake past what an agent locks
  {
    const big = expect(await call(approvePath("p-1"), { ...good, ring: 0, sizeEstimate: 401 }, founder.token), 400, "size-too-large");
    assert.match(big.error, /at most 400 lines a submission/);
    expect(await call(approvePath("p-1"), { ...good, ring: 2, sizeEstimate: 1000 }, founder.token), 400, "size-too-large");
  }
  assert.ok(!existsSync(file), "nothing written for a refusal");

  nextMinute();
  const approved = expect(await call(approvePath("p-1"), { ring: 1, sizeEstimate: 60, acceptanceTests: ["test/login.test.ts", "test/auth/timer.test.ts"] }, founder.token), 200);
  const p1Task = { kind: "task", id: tasks.taskIdFor("p-1"), proposalId: "p-1", ring: 1, acceptanceTestPaths: ["test/login.test.ts", "test/auth/timer.test.ts"], sizeEstimate: 60, specAuthor: founder.user.id };
  assert.equal(approved.added, true);
  assert.deepEqual(approved.proposal.task, { status: "pending", id: p1Task.id, ring: 1, sizeEstimate: 60, acceptanceTestPaths: p1Task.acceptanceTestPaths, specAuthor: { id: founder.user.id, name: "Founder" } });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [p1Task]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const noTemp = () => assert.deepEqual(readdirSync(builderData).filter((f) => f.includes(".tmp")), []);
  noTemp();
  // again: the same task, nothing written
  const before = readFileSync(file, "utf8");
  const again = expect(await call(approvePath("p-1"), { ring: 2, sizeEstimate: 1, acceptanceTests: ["other.ts"] }, founder.token), 200);
  assert.equal(again.added, false);
  assert.equal(again.proposal.task.ring, 1);
  assert.equal(readFileSync(file, "utf8"), before);
  later(tasks.VIEW_CACHE_MS + 1);
  assert.equal(expect(await call("/c/builders/commons/proposals"), 200).proposals.find((p: any) => p.id === "p-1").task.status, "pending");
  ok("approving: the steward only, held to the ledger's rules (nothing written for a refusal), the task body written whole, 0600, once");

  // the coordinator's pass, as `commons host` runs it: the file read as its
  // readApprovedTasks does, its own planner, the ledger's own checks
  const coordinatorPass = () => {
    const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    const approvedTasks = raw.map((t: object) => ({ ...t, kind: "task" }));
    const actions = coordinator.planActions(state, iso(), { approvedTasks }).filter((a: any) => a.kind === "task");
    for (const a of actions) append((a as any).body, coordKey);
    return actions.length;
  };
  assert.equal(coordinatorPass(), 1);
  assert.equal(coordinatorPass(), 0);
  assert.deepEqual({ ...state.tasks.get(p1Task.id), seq: undefined }, { ...p1Task, seq: undefined });
  later(tasks.VIEW_CACHE_MS + 1);
  {
    const p1 = expect(await call("/c/builders/commons/proposals"), 200).proposals.find((p: any) => p.id === "p-1");
    assert.equal(p1.task.status, "created");
    assert.equal(p1.task.state, "open");
  }
  expect(await call(approvePath("p-1"), good, founder.token), 400, "already-a-task");
  expect(await call(declinePath("p-1"), {}, founder.token), 400, "already-a-task");
  ok("the coordinator's own planner appends the approved task once, the ledger takes it, and it shows as created");

  // a spec author who isn't you; declining takes it back; hand-written
  // entries stay, and what's on the ledger already is dropped
  const handWritten = { id: "t-hand", proposalId: "p-unknown", ring: 1, acceptanceTestPaths: ["x.ts"], sizeEstimate: 1, specAuthor: mira.user.id, note: "by hand" };
  writeFileSync(file, JSON.stringify([p1Task, handWritten]));
  const forMira = expect(await call(approvePath("p-2"), { ring: 2, sizeEstimate: 10, acceptanceTests: ["test/lint.test.ts"], specAuthor: mira.user.id }, founder.token), 200);
  assert.deepEqual(forMira.proposal.task.specAuthor, { id: mira.user.id, name: "Mira" });
  const p2Task = { kind: "task", id: tasks.taskIdFor("p-2"), proposalId: "p-2", ring: 2, acceptanceTestPaths: ["test/lint.test.ts"], sizeEstimate: 10, specAuthor: mira.user.id };
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [handWritten, p2Task]);
  const declined = expect(await call(declinePath("p-2"), {}, founder.token), 200);
  assert.equal(declined.removed, true);
  assert.equal(declined.proposal.task, null);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [handWritten]);
  assert.equal(expect(await call(declinePath("p-2"), {}, founder.token), 200).removed, false);
  expect(await call(declinePath("nope"), {}, founder.token), 400);
  assert.equal(coordinatorPass(), 0);
  noTemp();
  ok("a spec author who isn't you; declining takes a pending approval out; hand-written entries stay, ones on the ledger go");

  // a decline that loses the race: the coordinator read the file (with the
  // approval) just before, and appends the task after the decline
  {
    nextMinute();
    propose(miraAgent, "p-race", "Racy", [{ kind: "location", file: "r.ts", line: 1, note: "r" }]);
    expect(await call(approvePath("p-race"), { ...good, sizeEstimate: 400, ring: 0 }, founder.token), 200);
    const readByPass = JSON.parse(readFileSync(file, "utf8"));
    const declinedNow = expect(await call(declinePath("p-race"), {}, founder.token), 200);
    assert.equal(declinedNow.removed, true);
    assert.equal(declinedNow.proposal.task, null);
    const until = Date.parse(declinedNow.watchUntil);
    assert.ok(until > Date.now() && until <= Date.now() + tasks.DECLINE_WATCH_MS, declinedNow.watchUntil);
    assert.equal(declinedNow.proposal.watchUntil, declinedNow.watchUntil);
    // listed as watched, on the first page
    later(tasks.VIEW_CACHE_MS + 1);
    const watched = expect(await call("/c/builders/commons/proposals"), 200).proposals.find((p: any) => p.id === "p-race");
    assert.equal(watched.task, null);
    assert.equal(watched.watchUntil, declinedNow.watchUntil);
    // the pass appends what it read
    const actions = coordinator.planActions(state, iso(), { approvedTasks: readByPass.map((t: object) => ({ ...t, kind: "task" })) }).filter((a: any) => a.kind === "task");
    assert.equal(actions.length, 1);
    append((actions[0] as any).body, coordKey);
    later(tasks.VIEW_CACHE_MS + 1);
    const landed = expect(await call("/c/builders/commons/proposals"), 200).proposals.find((p: any) => p.id === "p-race");
    assert.equal(landed.task.status, "created");
    assert.equal(landed.watchUntil, undefined);
    // one that doesn't land: watched until the window ends, then not
    propose(miraAgent, "p-calm", "Calm", [{ kind: "location", file: "c.ts", line: 1, note: "c" }]);
    expect(await call(approvePath("p-calm"), good, founder.token), 200);
    const calm = expect(await call(declinePath("p-calm"), {}, founder.token), 200);
    assert.ok(calm.watchUntil);
    // approving again stops the watch (it's pending, not declined)
    expect(await call(approvePath("p-calm"), good, founder.token), 200);
    later(tasks.VIEW_CACHE_MS + 1);
    assert.equal(expect(await call("/c/builders/commons/proposals"), 200).proposals.find((p: any) => p.id === "p-calm").watchUntil, undefined);
    expect(await call(declinePath("p-calm"), {}, founder.token), 200);
    later(tasks.DECLINE_WATCH_MS + 1);
    const settled = expect(await call("/c/builders/commons/proposals"), 200).proposals.find((p: any) => p.id === "p-calm");
    assert.equal(settled.task, null);
    assert.equal(settled.watchUntil, undefined);
    // nothing declined: nothing to watch
    assert.equal(expect(await call(declinePath("p-calm"), {}, founder.token), 200).watchUntil, undefined);
  }
  ok("a decline the coordinator's pass beat is watched for a minute, and shows as created when the task lands; one that doesn't land is open again after");

  // the ledger's rules, as they change: a rulesChange lowering the lines a
  // submission takes and the stake an agent can lock is what's held to next
  {
    nextMinute();
    propose(miraAgent, "p-size", "Size", [{ kind: "location", file: "s.ts", line: 1, note: "s" }]);
    const next = structuredClone(state.rules);
    next.version += 1;
    next.maxLinesPerSubmission = 150;
    next.stake.allowance = 50;
    append({ kind: "rulesChange", rules: next, pollId: "rules-small" }, admin);
    later(tasks.VIEW_CACHE_MS + 1);
    const limits = expect(await call("/c/builders/commons/proposals", undefined, founder.token), 200).sizeLimits;
    // ring 0: ceil(10 * (n/100)^1.5 * 4) <= 50 up to 116 lines; rings 1 and 2: the 150 a submission takes
    assert.deepEqual(limits.maxSizeEstimate, [116, 150, 150]);
    assert.equal(limits.stakeLimit, 50);
    const stake = expect(await call(approvePath("p-size"), { ...good, ring: 0, sizeEstimate: 117 }, founder.token), 400, "size-too-large");
    assert.match(stake.error, /claim stake of 51, more than an agent can lock \(50\): at most 116 lines in ring 0/);
    expect(await call(approvePath("p-size"), { ...good, ring: 1, sizeEstimate: 151 }, founder.token), 400, "size-too-large");
    expect(await call(approvePath("p-size"), { ...good, ring: 0, sizeEstimate: 116 }, founder.token), 200);
    assert.equal(coordinatorPass(), 1);
  }
  ok("the size a task can have follows the ledger's rules as they change (its rulesChanges), lines a submission and the stake an agent can lock");

  // several at once: each written in turn, none lost
  nextMinute();
  for (let i = 0; i < 5; i++) propose(miraAgent, `q-${i}`, `Q ${i}`, [{ kind: "location", file: `q${i}.ts`, line: 1, note: "q" }]);
  const all = await Promise.all(Array.from({ length: 5 }, (_, i) => call(approvePath(`q-${i}`), { ...good, sizeEstimate: i }, founder.token)));
  for (const r of all) expect(r, 200);
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(written.map((t: any) => t.proposalId).sort(), ["p-unknown", "q-0", "q-1", "q-2", "q-3", "q-4"]);
  assert.equal(coordinatorPass(), 5);
  noTemp();
  ok("approvals at once are written one after another, none lost, and all land");

  // a file that isn't a JSON array: never overwritten
  writeFileSync(file, "{ broken");
  expect(await call(approvePath("p-3"), good, founder.token), 502, "approved-tasks-malformed");
  expect(await call(declinePath("p-3"), {}, founder.token), 502, "approved-tasks-malformed");
  assert.equal(readFileSync(file, "utf8"), "{ broken");
  later(tasks.VIEW_CACHE_MS + 1);
  {
    const listed = expect(await call("/c/builders/commons/proposals"), 200);
    assert.match(listed.problem, /approved-tasks\.json/);
    assert.equal(listed.proposals.find((p: any) => p.id === "p-3").task, null);
  }
  writeFileSync(file, JSON.stringify([1]));
  expect(await call(approvePath("p-3"), good, founder.token), 502, "approved-tasks-malformed");
  rmSync(file);
  ok("a file that isn't a JSON array of objects is never overwritten, and the list says so");

  ////////////////////////////////////////////
  //// the coordinator out of reach, a fresh disk, the limits

  later(tasks.VIEW_CACHE_MS + 1);
  fake.down = true;
  expect(await call("/c/builders/commons/proposals"), 502);
  expect(await call(approvePath("p-3"), good, founder.token), 502);
  assert.ok(!existsSync(file));
  fake.down = false;

  // another ledger (the disk was wiped and the commons set up again): read
  // from the start, the old proposals gone
  genesis();
  const again2 = agentOf(founder.user.id);
  propose(again2, "n-1", "New start", [{ kind: "failingTest", testId: "n", command: "npm test" }]);
  later(tasks.VIEW_CACHE_MS + 1);
  const fresh = expect(await call("/c/builders/commons/proposals"), 200);
  assert.ok(fresh.proposals.every((p: any) => p.id.startsWith("n-")), JSON.stringify(fresh.proposals.map((p: any) => p.id)));
  assert.ok(fresh.proposals.some((p: any) => p.id === "n-1"));
  expect(await call(approvePath("p-1"), good, founder.token), 400);
  ok("the coordinator out of reach is a 502, nothing written; another ledger is read again from the start");

  // a long ledger: read on over several asks, and nothing approved before
  // it's all read
  for (let i = 0; i < 110; i++) propose(again2, `long-${i}`, `Long ${i}`, [{ kind: "failingTest", testId: "l", command: "npm test" }]);
  fake.pageSize = 1;
  nextMinute();
  const partial = expect(await call("/c/builders/commons/proposals"), 200);
  assert.ok(partial.total > 1 && partial.total < 111, String(partial.total));
  expect(await call(approvePath("n-1"), good, founder.token), 502);
  assert.ok(!existsSync(file));
  nextMinute();
  expect(await call(approvePath("n-1"), good, founder.token), 200);
  assert.equal(expect(await call("/c/builders/commons/proposals", undefined, founder.token), 200).total, 111);
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[0].proposalId, "n-1");
  fake.pageSize = 3;
  ok("a long ledger is read on over several asks, and nothing is approved until it's all read");

  // the list a page at a time: the pending approval (the oldest proposal)
  // first, then newest first; every proposal once, across the pages
  {
    propose(again2, "lots-of-evidence", "Evidence", Array.from({ length: 20 }, (_, i) => ({ kind: "location", file: `e${i}.ts`, line: i + 1, note: "x".repeat(400) })));
    later(tasks.VIEW_CACHE_MS + 1);
    nextMinute();
    const first = expect(await call("/c/builders/commons/proposals"), 200);
    assert.equal(first.total, 112);
    assert.equal(first.proposals[0].id, "n-1");
    assert.equal(first.proposals[0].task.status, "pending");
    assert.equal(first.proposals.length, 1 + tasks.PAGE_SIZE);
    assert.equal(first.proposals[1].id, "lots-of-evidence");
    // a few pieces of evidence each in the list, all of them for one
    assert.equal(first.proposals[1].evidence.length, tasks.LIST_EVIDENCE);
    assert.equal(first.proposals[1].evidenceTotal, 20);
    const one = expect(await call("/c/builders/commons/proposals/lots-of-evidence"), 200).proposal;
    assert.equal(one.evidence.length, 20);
    expect(await call("/c/builders/commons/proposals/nope"), 404);
    expect(await call("/c/builders/commons/proposals?before=x"), 400);
    const seen = first.proposals.map((p: any) => p.id);
    let next = first.next;
    let pages = 1;
    while (next !== null) {
      const page = expect(await call(`/c/builders/commons/proposals?before=${next}`), 200);
      assert.ok(page.proposals.length <= tasks.PAGE_SIZE);
      assert.ok(page.proposals.every((p: any) => p.id !== "n-1"), "the pending one only on the first page");
      seen.push(...page.proposals.map((p: any) => p.id));
      next = page.next;
      pages += 1;
    }
    assert.equal(pages, 3);
    assert.equal(new Set(seen).size, seen.length, "each once");
    assert.equal(seen.length, 112);
    // newest first after the pinned one
    assert.equal(seen[seen.length - 1], "long-0");
  }
  ok("the list is a page at a time, what waits on the coordinator always first, each proposal once; a few pieces of evidence each, all of them for one");

  nextMinute();
  for (let i = 0; i < 20; i++) expect(await call(declinePath("n-1"), {}, founder.token), 200);
  expect(await call(approvePath("n-1"), good, founder.token), 429);
  for (let i = 0; i < 30; i++) expect(await call("/c/builders/commons/proposals", undefined, mira.token), 200);
  expect(await call("/c/builders/commons/proposals", undefined, mira.token), 429);
  // reading one proposal shares the listing's budget
  expect(await call("/c/builders/commons/proposals/n-1", undefined, mira.token), 429);
  ok("approving and declining, and listing, are rate limited");

  rmSync(dir, { recursive: true, force: true });
  console.log("all task checks passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
