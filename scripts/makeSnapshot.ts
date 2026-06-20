// Generates anthillSnapshot.json for the READ-ONLY demo (SNAPSHOT_MODE=true),
// WITHOUT a chain/foundry. It seeds a binary tree + reputation votes using the
// backend's own mutation functions (the same ones it applies to chain events),
// recomputing depth/reputation and capturing a history step after each event —
// exactly like the live loader + dagHistory, just from synthetic events.
//
// Run: npx tsx scripts/makeSnapshot.ts   (writes ./anthillSnapshot.json)

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addDagVote,
  address0,
  address1,
  type GraphData,
  joinTree,
  type NodeDataStore,
} from "../src/dagBase";
import { resetIntermediate } from "../src/dagLoading";
import {
  calculateDepthAndRelRoot,
  calculateReputation,
  findRandomLeaf,
} from "../src/dagProcessing";
import type { History, HistoryNode, HistoryStep } from "../src/dagHistory";

const MAX_DEPTH = 5; // root at depth 0 → 2^(d+1)-1 = 63 nodes
const MAX_REL_ROOT_DEPTH = 6;

const NAMES = [
  "Ada", "Lin", "Noor", "Kai", "Mira", "Tao", "Iris", "Omar", "Yuki", "Sol",
  "Nadia", "Bo", "Lena", "Ravi", "Esme", "Jun", "Wren", " Amara".trim(), "Theo",
  "Zara", "Ines", "Hugo", "Maya", "Ozan", "Pia", "Eli", "Suki", "Remy", "Vera",
  "Cole", "Nia", "Arlo", "Faye", "Gus", "Hana", "Idris", "Juno", "Kira", "Lev",
  "Moss", "Nico", "Opal", "Pax", "Quill", "Rune", "Sage", "Tove", "Una", "Vale",
];

const addr = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
const nameFor = (i: number): string =>
  i === 0 ? "Satoshi" : NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${i}` : "");

const dag = {} as GraphData;
resetIntermediate(dag);
dag.maxRelRootDepth = MAX_REL_ROOT_DEPTH;

// Root predates the event log (seeded like initEmptyGraph / loadAnthillGraph).
const ROOT = addr(2);
dag.rootId = ROOT;
dag.dict[ROOT] = {
  id: ROOT,
  name: "Satoshi",
  totalWeight: 0n,
  currentRep: 0n,
  depth: 0,
  relRoot: ROOT,
  sentTreeVote: address1,
  recTreeVotes: [],
  sentDagVotes: [],
  recDagVotes: [],
} as NodeDataStore;
dag.dict[address1].recTreeVotes.push(ROOT);

const steps: HistoryStep[] = [];
let block = 0;
let index = 0;

function snapshotNodes(): HistoryNode[] {
  const nodes: HistoryNode[] = [];
  for (const id of Object.keys(dag.dict)) {
    if (id === address0 || id === address1) continue;
    const node = dag.dict[id];
    nodes.push({
      id: node.id,
      name: node.name,
      currentRep: node.currentRep.toString(),
      depth: node.depth,
      sentTreeVote: node.sentTreeVote,
      recTreeVotes: node.recTreeVotes,
      dagVotes: node.sentDagVotes.map((v) => v.id),
    });
  }
  return nodes;
}

function record(
  eventName: string,
  voter: string,
  recipient: string,
  name: string,
  weight: string,
) {
  const byDepth = [[]] as string[][];
  calculateDepthAndRelRoot(dag, byDepth);
  calculateReputation(dag, byDepth);
  steps.push({
    index: index++,
    eventName,
    voter,
    recipient,
    name,
    weight,
    blockNumber: block++,
    nodes: snapshotNodes(),
  });
}

// Build the binary tree breadth-first (exactly 2 children per node), recording a
// JoinTreeEvent step for each join — joinTree() also adds the weight-1 dag vote
// to the parent, just like the contract.
const parentOf = new Map<string, string>();
const depthOf = new Map<string, number>([[ROOT, 0]]);
let next = 3;
const queue: string[] = [ROOT];
while (queue.length > 0) {
  const parent = queue.shift() as string;
  const pd = depthOf.get(parent) ?? 0;
  if (pd >= MAX_DEPTH) continue;
  for (let c = 0; c < 2; c++) {
    const child = addr(next);
    const i = next - 2;
    next++;
    joinTree(dag, child, nameFor(i), parent);
    parentOf.set(child, parent);
    depthOf.set(child, pd + 1);
    queue.push(child);
    record("JoinTreeEvent", child, parent, nameFor(i), "1");
  }
}

// Add reputation votes up the tree: every node votes for its grandparent, and a
// third also for its great-grandparent — a realistic upward web (the parent vote
// already exists from joining). Weights vary for visual richness.
let salt = 7;
const ancestor = (id: string, up: number): string | undefined => {
  let cur: string | undefined = id;
  for (let k = 0; k < up && cur; k++) cur = parentOf.get(cur);
  return cur;
};
for (const id of [...depthOf.keys()]) {
  const d = depthOf.get(id) ?? 0;
  if (d >= 2) {
    const gp = ancestor(id, 2);
    if (gp) {
      const w = BigInt(1 + (salt % 3));
      addDagVote(dag, id, gp, w);
      record("AddDagVoteEvent", id, gp, "", w.toString());
    }
  }
  salt = (salt * 1103515245 + 12345) & 0x7fffffff;
  if (d >= 3 && salt % 3 === 0) {
    const ggp = ancestor(id, 3);
    if (ggp) {
      const w = BigInt(1 + (salt % 2));
      addDagVote(dag, id, ggp, w);
      record("AddDagVoteEvent", id, ggp, "", w.toString());
    }
  }
}

// Final derived state + a random leaf.
const byDepth = [[]] as string[][];
calculateDepthAndRelRoot(dag, byDepth);
calculateReputation(dag, byDepth);
const randomLeaf = findRandomLeaf(dag);

const history: History = { steps };

function bigintReplacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? { __bigint__: v.toString() } : v;
}

const out = join(process.cwd(), "anthillSnapshot.json");
writeFileSync(
  out,
  JSON.stringify({ graph: dag, history, randomLeaf }, bigintReplacer),
);
const nodeCount = Object.keys(dag.dict).length - 1; // minus address1 sentinel
console.log(
  `Wrote ${out}: ${nodeCount} nodes, ${steps.length} history steps, randomLeaf ${randomLeaf}`,
);
