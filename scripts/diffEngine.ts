// Differential test: the TypeScript engine (src/engine.ts) against the Solidity
// contract it ports. Deploys a fresh Anthill to anvil, then runs the same random
// actions on both and checks after every step that
//   - both succeed or both revert (with the same reason), and
//   - the whole storage reachable from the tree is identical (tree votes, dag
//     votes with dist/posInOther, weights, names, stored reputation).
//
//   anvil --port 8546 --silent &
//   (cd ../anthill-contracts && forge build src/Anthill.sol)
//   npx tsx scripts/diffEngine.ts            # STEPS=500 SEED=1 RPC=http://localhost:8546
//
// The contract is deployed unlocked, so one funded account can act for any
// voter, like the server does.
//
// It also reports the first action after which some member is no longer
// reachable from the root (a corrupted tree, which the contract allows).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Abi,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { AnthillEngine, address0, address1, Revert } from "../src/engine";

const rpc = process.env.RPC || "http://localhost:8546";
const steps = Number(process.env.STEPS || 500);
let seed = Number(process.env.SEED || 1);

const artifact = JSON.parse(
  readFileSync(
    join(__dirname, "../../anthill-contracts/out/Anthill.sol/Anthill.json"),
    "utf8",
  ),
);
const abi = artifact.abi as Abi;

// anvil's first prefunded dev account.
const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const chain = { ...foundry, rpcUrls: { default: { http: [rpc] } } };
const publicClient = createPublicClient({
  chain,
  transport: http(rpc, { batch: { batchSize: 2000 } }),
});
const walletClient = createWalletClient({ account, chain, transport: http(rpc) });

// Deterministic RNG (mulberry32), so a failing SEED can be replayed.
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];

const pool = Array.from(
  { length: 60 },
  (_, i) => `0x${(i + 2).toString(16).padStart(40, "0")}`,
);

type Reader = {
  root: () => Promise<string>;
  nameOf: (a: string) => Promise<string>;
  sentTreeVote: (a: string) => Promise<string>;
  recTreeVoteCount: (a: string) => Promise<bigint>;
  recTreeVote: (a: string, i: bigint) => Promise<string>;
  sentDagVoteCount: (a: string) => Promise<bigint>;
  sentDagVote: (a: string, i: bigint) => Promise<readonly unknown[]>;
  recDagVoteCount: (a: string) => Promise<bigint>;
  recDagVote: (a: string, i: bigint) => Promise<readonly unknown[]>;
  sentDagVoteTotalWeight: (a: string) => Promise<bigint>;
  reputation: (a: string) => Promise<bigint>;
};

function chainReader(address: Hex): Reader {
  const read = (functionName: string) => async (...args: unknown[]) =>
    publicClient.readContract({ address, abi, functionName, args }) as Promise<any>;
  return {
    root: read("root"),
    nameOf: read("nameOf"),
    sentTreeVote: read("sentTreeVote"),
    recTreeVoteCount: read("recTreeVoteCount"),
    recTreeVote: read("recTreeVote"),
    sentDagVoteCount: read("sentDagVoteCount"),
    sentDagVote: read("sentDagVote"),
    recDagVoteCount: read("recDagVoteCount"),
    recDagVote: read("recDagVote"),
    sentDagVoteTotalWeight: read("sentDagVoteTotalWeight"),
    reputation: read("reputation"),
  };
}

function engineReader(engine: AnthillEngine): Reader {
  const r = engine.read;
  return {
    root: () => r.root(),
    nameOf: (a) => r.nameOf([a]),
    sentTreeVote: (a) => r.sentTreeVote([a]),
    recTreeVoteCount: (a) => r.recTreeVoteCount([a]),
    recTreeVote: (a, i) => r.recTreeVote([a, i]),
    sentDagVoteCount: (a) => r.sentDagVoteCount([a]),
    sentDagVote: (a, i) => r.sentDagVote([a, i]),
    recDagVoteCount: (a) => r.recDagVoteCount([a]),
    recDagVote: (a, i) => r.recDagVote([a, i]),
    sentDagVoteTotalWeight: (a) => r.sentDagVoteTotalWeight([a]),
    reputation: (a) => r.reputation([a]),
  };
}

// Everything reachable from the tree (plus every pool address's tree vote),
// normalised to lowercase strings.
async function dump(r: Reader) {
  const lower = (x: unknown) => (typeof x === "string" ? x.toLowerCase() : String(x));
  const ids: string[] = [];
  const children: Record<string, string[]> = {};
  let level = [address1];
  while (level.length > 0) {
    const counts = await Promise.all(level.map((id) => r.recTreeVoteCount(id)));
    const next = await Promise.all(
      level.map((id, k) =>
        Promise.all(
          Array.from({ length: Number(counts[k]) }, (_, i) => r.recTreeVote(id, BigInt(i))),
        ),
      ),
    );
    level.forEach((id, k) => {
      children[id] = next[k].map(lower);
    });
    level = next.flat().map(lower).filter((id) => id !== address0);
    ids.push(...level);
  }

  const nodes = await Promise.all(
    ids.map(async (id) => {
      const [name, parent, sCount, rCount, weight, rep] = await Promise.all([
        r.nameOf(id),
        r.sentTreeVote(id),
        r.sentDagVoteCount(id),
        r.recDagVoteCount(id),
        r.sentDagVoteTotalWeight(id),
        r.reputation(id),
      ]);
      const sent = await Promise.all(
        Array.from({ length: Number(sCount) }, (_, i) => r.sentDagVote(id, BigInt(i))),
      );
      const rec = await Promise.all(
        Array.from({ length: Number(rCount) }, (_, i) => r.recDagVote(id, BigInt(i))),
      );
      return [
        id,
        {
          name,
          parent: lower(parent),
          children: children[id],
          weight: String(weight),
          rep: String(rep),
          sent: sent.map((v) => v.map(lower).join(",")),
          rec: rec.map((v) => v.map(lower).join(",")),
        },
      ];
    }),
  );
  const parents = await Promise.all(pool.map((id) => r.sentTreeVote(id)));
  return {
    root: lower(await r.root()),
    rootSlots: children[address1],
    pool: parents.map(lower),
    nodes: Object.fromEntries(nodes),
  };
}

function chainOutcome(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      if (revert.data?.errorName === "Panic") return "panic";
      if (revert.reason !== undefined) return revert.reason;
    }
    if (e.message.includes("StackOverflow")) return "stack overflow";
  }
  return `error: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
}

function engineOutcome(e: unknown): string {
  if (e instanceof Revert) return e.message.startsWith("panic") ? "panic" : e.message;
  // BigInt division by zero is Solidity's division panic.
  if (e instanceof RangeError && e.message.includes("Division by zero")) return "panic";
  if (e instanceof RangeError && e.message.includes("call stack")) return "stack overflow";
  return `crash: ${e instanceof Error ? e.stack : String(e)}`;
}

type Step = { fn: string; args: unknown[] };

function nextAction(engine: AnthillEngine): Step {
  const members = pool.filter((id) => engine.isInTree(id));
  const outsiders = pool.filter((id) => !engine.isInTree(id));
  if (members.length === 0) {
    return { fn: "joinTreeAsRoot", args: [pick(pool), "root"] };
  }
  // mostly members, sometimes anyone (to exercise reverts)
  const voter = random() < 0.9 ? pick(members) : pick(pool);
  const r = random();

  if (r < 0.25 && outsiders.length > 0) {
    return { fn: "joinTree", args: [pick(outsiders), `n${Math.floor(random() * 1000)}`, pick(members)] };
  }
  if (r < 0.55) {
    let recipient = pick(members);
    if (random() < 0.5 && engine.isInTree(voter)) {
      recipient = engine.findNthParent(voter, 2 + Math.floor(random() * 4));
    }
    return { fn: "addDagVote", args: [voter, recipient, BigInt(1 + Math.floor(random() * 5))] };
  }
  if (r < 0.65) {
    let recipient = pick(members);
    if (random() < 0.8) {
      // usually one of the voter's existing votes
      const votes = members.filter((m) => engine.findSentDagVote(voter, m)[1]);
      if (votes.length > 0) recipient = pick(votes);
    }
    return { fn: "removeDagVote", args: [voter, recipient] };
  }
  if (r < 0.77) {
    return { fn: "switchPositionWithParent", args: [voter] };
  }
  if (r < 0.9) {
    return { fn: "moveTreeVote", args: [voter, pick(members)] };
  }
  if (r < 0.95) {
    return { fn: "leaveTree", args: [voter] };
  }
  return { fn: "changeName", args: [voter, `renamed${Math.floor(random() * 100)}`] };
}

async function main() {
  const hash = await walletClient.deployContract({
    abi,
    bytecode: artifact.bytecode.object as Hex,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const address = receipt.contractAddress!;
  const chainState = chainReader(address);
  const engine = new AnthillEngine();
  const engineState = engineReader(engine);
  console.log("deployed Anthill at", address, "seed", seed);

  const counts: Record<string, { ok: number; reverted: number }> = {};
  let corruptedBy: string | undefined;
  const startSeed = seed;

  for (let step = 0; step < steps; step++) {
    const { fn, args } = nextAction(engine);

    let engineResult = "ok";
    try {
      engine.run((e) => (e as any)[fn](...args));
    } catch (e) {
      engineResult = engineOutcome(e);
    }

    let chainResult = "ok";
    try {
      const { request } = await publicClient.simulateContract({
        account,
        address,
        abi,
        functionName: fn,
        args,
      });
      const txHash = await walletClient.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
    } catch (e) {
      chainResult = chainOutcome(e);
    }
    if (chainResult.includes("StackOverflow")) chainResult = "stack overflow";

    counts[fn] ??= { ok: 0, reverted: 0 };
    counts[fn][chainResult === "ok" ? "ok" : "reverted"] += 1;

    const label = `step ${step} ${fn}(${args.join(", ")})`;
    if (engineResult !== chainResult) {
      console.error(`MISMATCH at ${label}\n  chain:  ${chainResult}\n  engine: ${engineResult}`);
      process.exit(1);
    }

    const [a, b] = await Promise.all([dump(chainState), dump(engineState)]);
    const ja = JSON.stringify(a);
    const jb = JSON.stringify(b);
    if (ja !== jb) {
      console.error(`STATE MISMATCH after ${label} (${chainResult})`);
      for (const id of new Set([...Object.keys(a.nodes), ...Object.keys(b.nodes)])) {
        const na = JSON.stringify((a.nodes as any)[id]);
        const nb = JSON.stringify((b.nodes as any)[id]);
        if (na !== nb) console.error(`  ${id}\n    chain:  ${na}\n    engine: ${nb}`);
      }
      if (a.root !== b.root) console.error(`  root chain ${a.root} engine ${b.root}`);
      process.exit(1);
    }

    if (corruptedBy === undefined) {
      const lost = pool.filter((id) => engine.isInTree(id) && a.nodes[id] === undefined);
      if (lost.length > 0) {
        corruptedBy = label;
        console.warn(`tree corrupted (on both) by ${label}: unreachable ${lost.join(", ")}`);
      }
    }
  }

  const members = pool.filter((id) => engine.isInTree(id)).length;
  console.log(`ok: ${steps} steps identical (seed ${startSeed}), ${members} members at the end`);
  console.table(counts);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
