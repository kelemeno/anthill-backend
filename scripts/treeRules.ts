// Checks of the tree rules the server adds around the engine, run in-process
// on a throwaway data dir (no server needed): reputation stays cheap on deep
// endorsement chains (and equals the contract's uncached recursion), nobody
// can get under the engine's scratch node (and whoever is there counts as
// outside the tree, and a rename skips the tree they're stuck in), malformed
// args are refused per item, names lose invisible characters but keep emoji
// sequences and joiners scripts need, founderless trees start unless closed, relRoot matches the engine, and closed communities
// are logged in the form older code reads as invite only.
//
//   npx tsx scripts/treeRules.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateDepthAndRelRoot } from "../src/dagProcessing";
import type { GraphData } from "../src/dagBase";
import { type AnthillEngine, address0, address1, tempAddress } from "../src/engine";
import { ActionError, Communities, type OffchainTree, parseName } from "../src/offchain";
import { Store } from "../src/store";

const id = (i: number) => `0x${(0x1000 + i).toString(16).padStart(40, "0")}`;
const freshStore = () => new Store(mkdtempSync(join(tmpdir(), "anthill-rules-")));

// Throws unless the action is refused with an ActionError (a 400, not a 500).
function refused(tree: OffchainTree, by: string, body: unknown, why?: RegExp) {
  assert.throws(
    () => tree.execute(by, body),
    (e) => e instanceof ActionError && (why === undefined || why.test(e.message)),
    JSON.stringify(body),
  );
}

// The contract's reputation: every path recomputed (exponential), for comparison.
async function contractReputation(e: AnthillEngine, voter: string): Promise<bigint> {
  let rep = 0n;
  const count = Number(await e.read.recDagVoteCount([voter]));
  for (let i = 0; i < count; i++) {
    const [from, weight] = await e.read.recDagVote([voter, BigInt(i)]);
    rep += ((await contractReputation(e, from)) * weight) / (await e.read.sentDagVoteTotalWeight([from]));
  }
  return rep + 10n ** 18n;
}

// A chain of n people under `root`, each endorsing everyone up to 6 levels up.
function chain(tree: OffchainTree, root: string, n: number): string[] {
  const ids = [root];
  for (let i = 1; i <= n; i++) {
    tree.execute(id(i), { fn: "joinTree", args: { name: `n${i}`, recipient: ids.at(-1) } });
    for (const up of ids.slice(-6, -1)) {
      tree.execute(id(i), { fn: "addDagVote", args: { recipient: up, weight: String(1 + (i % 3)) } });
    }
    ids.push(id(i));
  }
  return ids;
}

async function main() {
  const store = freshStore();
  const communities = new Communities(store);
  const founder = { id: id(0), name: "Founder" };
  const settings = { name: "Rules", visibility: "public", joinPolicy: "open" };
  const { tree } = communities.create(founder, { id: "rules", ...settings });

  // Reputation: the same numbers as the contract's recursion, computed once
  // per node, so a deep chain's switch check stays fast.
  const short = chain(tree, founder.id, 14);
  for (const m of short) {
    assert.equal(tree.engine.calculateReputation(m), await contractReputation(tree.engine, m), m);
  }
  const long = communities.create({ id: id(100), name: "Deep" }, { id: "deep", ...settings }).tree;
  const deep = chain(long, id(100), 80);
  const started = performance.now();
  const results = long.check(deep.at(-1)!, Array(5).fill({ fn: "switchPositionWithParent" }));
  const took = performance.now() - started;
  assert.equal(results.length, 5);
  assert.ok(took < 1000, `5 switch checks on an 80-deep chain took ${took}ms`);
  console.log(`ok: reputation (5 switch checks, 80 deep: ${took.toFixed(0)}ms)`);

  // The scratch node: after any local move the engine has it "in the tree".
  const [a, b] = [short[13], short[14]];
  tree.execute(b, { fn: "moveTreeVote", args: { recipient: short[11] } });
  assert.ok(tree.engine.isInTree(tempAddress));
  for (const sentinel of [tempAddress, address1, address0]) {
    refused(tree, a, { fn: "moveTreeVote", args: { recipient: sentinel } }, /isn't in the tree/);
    refused(tree, id(500), { fn: "joinTree", args: { name: "X", recipient: sentinel } }, /isn't in the tree/);
    refused(tree, a, { fn: "addDagVote", args: { recipient: sentinel } }, /isn't in the tree/);
    assert.equal(tree.check(a, [{ fn: "moveTreeVote", args: { recipient: sentinel } }])[0].ok, false);
  }
  // someone the engine let in there (before the server refused it) is treated
  // as outside: not a member, no invites, no reach, listed as detached
  tree.replay({ type: "action", at: "", by: a, action: { fn: "moveTreeVote", args: { recipient: tempAddress } } });
  assert.equal(tree.engine.parent(a), tempAddress);
  assert.equal(tree.isMember(a), false);
  assert.deepEqual(tree.detached(), [a]);
  assert.deepEqual(tree.reach(a), []);
  assert.throws(() => tree.createInvite(a), ActionError);
  assert.throws(() => tree.createAdminInvite(a), ActionError);
  refused(tree, id(501), { fn: "joinTree", args: { name: "Y", recipient: a } }, /isn't in the tree/);
  refused(tree, b, { fn: "moveTreeVote", args: { recipient: a } }, /isn't in the tree/);
  refused(tree, a, { fn: "switchPositionWithParent" }, /Join the tree first/);
  refused(tree, a, { fn: "changeName", args: { name: "Ghost" } }, /Join the tree first/);
  // renaming the account skips that tree instead of failing halfway
  const renamed = communities.rename({ id: a, name: "n13" }, { name: "Stuck" });
  assert.deepEqual(
    renamed.map((r) => r.tree.id),
    ["deep"],
  );
  assert.equal(long.engine.name(a), "Stuck");
  assert.equal(tree.engine.name(a), "n13");
  // they can still leave
  tree.execute(a, { fn: "leaveTree" });
  assert.deepEqual(tree.detached(), []);
  console.log("ok: the scratch node can't be joined or moved under");

  // Malformed args: a 400 each, and a dry run answers every item.
  for (const args of [null, "x", 3, []]) {
    refused(tree, short[1], { fn: "addDagVote", args }, /args must be an object/);
    refused(tree, id(502), { fn: "joinTree", args }, /args must be an object/);
  }
  const mixed = tree.check(short[2], [
    { fn: "joinTree", args: null },
    { fn: "changeName", args: { name: "Fine" } },
    null,
  ]);
  assert.deepEqual(
    mixed.map((r) => r.ok),
    [false, true, false],
  );
  console.log("ok: malformed args");

  // Names: invisible characters go; emoji sequences, subdivision flags and
  // the joiners Persian and Indic words need stay.
  for (const kept of ["Ali 🏳️‍🌈", "👨‍👩‍👧", "👩🏽‍💻 Dev", "نرگس\u200Cزاده", "क्\u200Dष", "🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} Scot"]) {
    assert.equal(parseName(kept), kept);
  }
  for (const [given, stored] of [
    ["A\u200Dli", "Ali"],
    ["\u200CAli\u200D", "Ali"],
    ["Al\u200Bi\u202E", "Ali"],
    ["Ali \u200D Bob", "Ali Bob"],
    ["Ali\u{E0041}", "Ali"],
    ["\u3164 Ali", "Ali"],
  ]) {
    assert.equal(parseName(given), stored, JSON.stringify(given));
  }
  for (const blank of ["\u200D", "\u200D\u200C", "\u3164", "\u{E0041}"]) {
    assert.throws(() => parseName(blank), ActionError);
  }
  console.log("ok: names");

  // A founderless tree (a fresh commons) can be started by anyone unless
  // it's closed (an invite-only one has nobody yet to give an invite).
  const commons = communities.get("commons")!;
  assert.equal(commons.info.createdBy, "");
  const { name, description, visibility } = commons.info;
  const start = { fn: "joinTreeAsRoot", args: { name: "Anyone" } };
  for (const joinPolicy of ["open", "invite", "closed"] as const) {
    store.updateCommunity("commons", { name, description, visibility, joinPolicy });
    assert.equal(commons.check(id(600), [start])[0].ok, joinPolicy !== "closed", joinPolicy);
  }
  // and a founded one only by its founder
  assert.equal(tree.check(id(600), [start])[0].ok, false);
  console.log("ok: founderless trees start unless closed");

  // relRoot as served is the engine's relative root (6 levels up).
  const graph: GraphData = { rootId: long.engine.root(), maxRelRootDepth: 6, dict: {} };
  for (const m of deep) {
    graph.dict[m] = { id: m, recTreeVotes: long.engine.children(m) } as GraphData["dict"][string];
  }
  calculateDepthAndRelRoot(graph, []);
  for (const m of deep) assert.equal(graph.dict[m].relRoot, long.engine.findRelRoot(m)[0], m);
  console.log("ok: relRoot");

  // Closed is logged as invite plus a flag (code from before "closed" reads
  // it as invite only), and read back as closed.
  const rules = { name: "Rules", description: "", visibility: "public" } as const;
  store.updateCommunity("rules", { ...rules, joinPolicy: "closed" });
  const logged = readFileSync(store.logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(
    [logged.at(-1).settings.joinPolicy, logged.at(-1).settings.closed],
    ["invite", true],
  );
  assert.equal(tree.info.joinPolicy, "closed");
  assert.equal("closed" in tree.info, false);
  const reread = new Store(join(store.logPath, ".."));
  assert.equal(reread.community("rules")!.joinPolicy, "closed");
  store.updateCommunity("rules", { ...rules, joinPolicy: "open" });
  assert.equal(tree.info.joinPolicy, "open");
  assert.equal(new Store(join(store.logPath, "..")).community("rules")!.joinPolicy, "open");
  console.log("ok: closed communities are logged rollback-safe");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
