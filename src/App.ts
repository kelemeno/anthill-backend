import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { WSContext } from "hono/ws";
import type { Address, Log } from "viem";
import {
  type AnthillContractType,
  anthillAbi,
  makeAnthillContract,
  makePublicClient,
} from "./anthillContract";
import { AuthError, PasskeyAuth } from "./auth";
import {
  addDagVote,
  address0,
  changeName,
  type DagVote,
  type DagVoteString,
  dagVoteString,
  type GraphData,
  joinTree,
  leaveTree,
  moveTreeVote,
  type NodeDataStore,
  removeDagVote,
  switchPositionWithParent,
} from "./dagBase";
import { loadAnthillGraph } from "./dagLoading";
import {
  calculateDepthAndRelRoot,
  calculateReputation,
  findRandomLeaf,
} from "./dagProcessing";
import {
  buildHistory,
  type History,
  type HistoryStep,
  snapshotNodes,
} from "./dagHistory";
import type { AnthillEngine, EngineEvent } from "./engine";
import { ActionError, OffchainTree } from "./offchain";
import { type ActionEntry, Store } from "./store";

/////////////////////////////////////////

// Spinning the Hono http server and the WebSocket server on the same port.
const app = new Hono();

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

let port = process.env.PORT;

if (port == null || port == "") {
  port = "5001";
}

// I'm maintaining all active connections in this object
const clients: { [id: string]: WSContext } = {};

//////////////////////////////
////// serve

// permissive CORS (Access-Control-Allow-Origin: *)
app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
    ],
  }),
);

// WebSocket endpoint. Accepts connections and (via replaceServe) broadcasts
// the string "update" to all clients on graph changes.
app.get(
  "/",
  upgradeWebSocket(() => {
    const userId = randomUUID();
    return {
      onOpen(_event, ws) {
        console.log(`Recieved a new connection.`);
        clients[userId] = ws;
        console.log(`${userId} connected.`);
        ws.send("Hello from the server");
      },
      onMessage(event) {
        console.log("received: %s", event.data);
      },
      onError(err) {
        console.log(err);
      },
      onClose() {
        delete clients[userId];
      },
    };
  }),
);

app.get("/maxRelRootDepth", (c) => {
  console.log("getting max rel root");
  return c.json({ maxRelRootDepth: maxRelRootDepth });
});

app.get("/rootId", (c) => {
  console.log("getting root");
  return c.json({ id: anthillRootIdServe });
});

app.get("/isNodeInGraph/:id", (c) => {
  const id = c.req.param("id");
  console.log("isNodeInGraph", id);
  if (anthillGraphServe.dict[id] === undefined) {
    return c.json({ isNodeInGraph: false });
  } else {
    return c.json({ isNodeInGraph: true });
  }
});

app.get("/id/:id", (c) => {
  const id = c.req.param("id");
  console.log("Getting id: ", id);
  if (
    id === "undefined" ||
    id === undefined ||
    anthillGraphServe.dict[id] === undefined
  ) {
    return c.json({ message: "User not found" }, 404);
  } else {
    return c.json({
      nodeData: NodeDataStoreCollapse(anthillGraphServe.dict[id]),
    });
  }
});

app.get("/bareId/:id", (c) => {
  const id = c.req.param("id");
  console.log("Getting bare id: ", id);
  // console.log("displaying: ", anthillGraphServe[id])
  const nodeData = anthillGraphServe.dict[id];

  return c.json({ nodeData: NodeDataBareCollapse(nodeData) });
});

// The whole served graph in one response, so the frontend can load it with a
// single request instead of one per node. `version` changes on every update.
app.get("/graph", (c) => {
  const nodes: { [id: string]: NodeDataString } = {};
  for (const [id, node] of Object.entries(anthillGraphServe.dict)) {
    nodes[id] = NodeDataStoreCollapse(node);
  }
  return c.json({
    version: anthillGraphNumServe,
    rootId: anthillRootIdServe,
    maxRelRootDepth: maxRelRootDepth,
    randomLeaf: randomLeafServe,
    nodes,
  });
});

app.get("/randomLeaf", (c) => {
  console.log("getting random leaf");

  return c.json({ randomLeaf: randomLeafServe });
});

// Full evolution of the graph as per-event snapshots, built by replaying all
// past on-chain events. Built once lazily and cached in memory.
let historyCache: History | null = null;
let historyPromise: Promise<History> | null = null;

app.get("/history", async (c) => {
  console.log("getting history");
  if (historyCache === null) {
    if (historyPromise === null) {
      historyPromise = buildHistory(
        publicClient,
        anthillContractAddress,
        AnthillContract,
      );
    }
    historyCache = await historyPromise;
  }
  return c.json(historyCache);
});

//////////////////////////////
////// passkey sign-in and actions (off-chain mode only)

app.onError((err, c) => {
  if (err instanceof AuthError) {
    return c.json({ error: err.message }, 401);
  }
  if (err instanceof ActionError) {
    return c.json({ error: err.message }, 400);
  }
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

function requireOffchain() {
  if (offchain === undefined || auth === undefined) {
    throw new ActionError("this server is read-only");
  }
  return { offchain, auth };
}

async function jsonBody(c: { req: { json: () => Promise<any> } }) {
  return c.req.json().catch(() => {
    throw new ActionError("expected a JSON body");
  });
}

app.post("/auth/register/options", async (c) => {
  const { auth } = requireOffchain();
  const { name } = await jsonBody(c);
  if (typeof name !== "string" || name.trim() === "" || name.trim().length > 40) {
    throw new ActionError("name must be 1-40 characters");
  }
  return c.json(await auth.registrationOptions(name.trim()));
});

app.post("/auth/register/verify", async (c) => {
  const { auth } = requireOffchain();
  const { flowId, response } = await jsonBody(c);
  return c.json(await auth.verifyRegistration(flowId, response));
});

app.post("/auth/login/options", async (c) => {
  const { auth } = requireOffchain();
  return c.json(await auth.authenticationOptions());
});

app.post("/auth/login/verify", async (c) => {
  const { auth } = requireOffchain();
  const { flowId, response } = await jsonBody(c);
  return c.json(await auth.verifyAuthentication(flowId, response));
});

app.get("/auth/me", (c) => {
  const { auth } = requireOffchain();
  return c.json({ user: auth.userFromHeader(c.req.header("Authorization")) });
});

// Run one tree action as the signed-in user. Actions are handled one at a time
// so each history step shows the graph right after its own action.
app.post("/action", async (c) => {
  const { offchain, auth } = requireOffchain();
  const user = auth.userFromHeader(c.req.header("Authorization"));
  const body = await jsonBody(c);
  await serially(async () => {
    const { entry, events } = offchain.execute(user.id, body);
    await rebuildFromEngine(offchain.engine);
    historyCache?.steps.push(historyStep(entry, events));
    replaceServe();
  });
  return c.json({ ok: true });
});

let actionQueue: Promise<void> = Promise.resolve();
function serially(fn: () => Promise<void>): Promise<void> {
  const result = actionQueue.then(fn);
  actionQueue = result.catch(() => undefined);
  return result;
}

const server = serve(
  {
    fetch: app.fetch,
    port: Number(port),
  },
  () => {
    console.log(`WebSocket and http server is running on port ${port}`);
    if (snapshotMode) {
      loadSnapshot();
    } else if (offchainMode) {
      startOffchain();
    } else {
      crawlEthereum(testing);
    }
  },
);
injectWebSocket(server);

/////////////////////////////////////////

let anthillGraphServe = {} as GraphData;
let anthillGraphNumServe = 0;

let anthillRootIdServe = address0;
let randomLeafServe = address0;

function replaceServe() {
  anthillGraphServe = anthillGraph;
  anthillGraphNumServe = anthillGraphNum;
  anthillRootIdServe = anthillRootId;
  randomLeafServe = randomLeaf;

  Object.values(clients).forEach((client) => {
    client.send("update");
  });
}

function NodeDataStoreCollapse(node: NodeDataStore): NodeDataString {
  const nodec = {} as NodeDataString;
  nodec.id = node.id;
  nodec.name = node.name;

  nodec.depth = node.depth;
  nodec.currentRep = node.currentRep.toString();
  nodec.relRoot = node.relRoot;

  nodec.totalWeight = node.totalWeight.toString();
  nodec.sentTreeVote = node.sentTreeVote;
  nodec.recTreeVotes = node.recTreeVotes;

  nodec.sentDagVotes = [] as DagVoteString[];
  nodec.recDagVotes = [] as DagVoteString[];

  node.recDagVotes.forEach((rDagVote) => {
    nodec.recDagVotes.push(dagVoteString(rDagVote));
  });

  node.sentDagVotes.forEach((sDagVote) => {
    nodec.sentDagVotes.push(dagVoteString(sDagVote));
  });

  return nodec;
}

//////////////////////
///// Load

// web3
let providerURL: string;
let anthillContractAddress: Address;

// Three modes:
// - off-chain (default): the tree lives on this server (see offchain.ts),
//   people sign in with passkeys, state is kept in DATA_DIR (default ./data).
//   A fresh data dir is seeded from anthillSnapshot.json, or starts empty with
//   SEED=empty.
// - SNAPSHOT_MODE=true: read-only demo, serves the frozen graph from
//   anthillSnapshot.json.
// - CHAIN_MODE=true: the original setup, reads the Anthill contract and follows
//   its events. CAPTURE_SNAPSHOT=true does a one-off live load (against the
//   testing anvil) and writes the snapshot file.
const snapshotMode = process.env.SNAPSHOT_MODE === "true";
const captureSnapshot = process.env.CAPTURE_SNAPSHOT === "true";
const chainMode = process.env.CHAIN_MODE === "true" || captureSnapshot;
const offchainMode = !snapshotMode && !chainMode;
const snapshotPath = join(process.cwd(), "anthillSnapshot.json");

const testing = true;

if (snapshotMode || offchainMode) {
  // Chain config is unused without a chain; harmless placeholder so no socket
  // is ever opened.
  providerURL = "http://localhost:1";
  anthillContractAddress = address0 as Address;
} else if (testing) {
  providerURL = "ws://localhost:8545";

  anthillContractAddress = "0x5fbdb2315678afecb367f032d93f642f64180aa3"; // forge without lib
} else {
  providerURL =
    process.env.RPC_URL || "wss://ethereum-sepolia-rpc.publicnode.com";

  anthillContractAddress = (process.env.CONTRACT_ADDRESS ||
    "0x0000000000000000000000000000000000000000") as Address;
}

const publicClient = makePublicClient(providerURL);

// contract
const AnthillContract = makeAnthillContract(
  anthillContractAddress,
  publicClient,
);

// types
export type NodeData = {
  id: string;
  name: string;
  totalWeight: bigint;
  currentRep: bigint;
  depth: number;
  relRoot: string;
  sentTreeVote: string;
  recTreeVotes: string[];
  sentDagVotes: DagVote[];
  recDagVotes: DagVote[];
};

export type NodeDataString = {
  id: string;
  name: string;
  totalWeight: string;
  currentRep: string;
  depth: number;
  relRoot: string;
  sentTreeVote: string;
  recTreeVotes: string[];
  sentDagVotes: DagVoteString[];
  recDagVotes: DagVoteString[];
};

export type NodeDataBare = {
  id: string;
  name: string;
  totalWeight: bigint;
  currentRep: bigint;
  depth: number;
  relRoot: string;
  sentTreeVote: string;
  recTreeVotes: string[];
};

export type NodeDataBareString = {
  id: string;
  name: string;
  totalWeight: string;
  currentRep: string;
  depth: number;
  relRoot: string;
  sentTreeVote: string;
  recTreeVotes: string[];
};

function NodeDataBareCollapse(node: NodeDataBare): NodeDataBareString {
  const nodec = {} as NodeDataBareString;
  nodec.id = node.id;
  nodec.name = node.name;
  nodec.totalWeight = node.totalWeight.toString();
  nodec.currentRep = node.currentRep.toString();
  nodec.depth = node.depth;
  nodec.relRoot = node.relRoot;
  nodec.sentTreeVote = node.sentTreeVote;
  nodec.recTreeVotes = node.recTreeVotes;
  return nodec;
}

const anthillGraph = {} as GraphData;
let anthillGraphByDepth = [[]] as string[][];
let anthillGraphNum = 0;
let maxRelRootDepth = 6;
let anthillRootId = address0;
let randomLeaf = address0;

// JSON (de)serialisation that survives bigints (totalWeight / currentRep / dag
// vote weights), used by the snapshot read/write.
type Snapshot = { graph: GraphData; history: History; randomLeaf: string };

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? { __bigint__: value.toString() } : value;
}
function bigintReviver(_key: string, value: unknown) {
  if (
    value !== null &&
    typeof value === "object" &&
    "__bigint__" in value &&
    typeof (value as { __bigint__: unknown }).__bigint__ === "string"
  ) {
    return BigInt((value as { __bigint__: string }).__bigint__);
  }
  return value;
}

// Read-only path: load the frozen graph + history straight into the served
// state. No chain client, no event subscription.
function loadSnapshot() {
  console.log("Loading frozen snapshot from", snapshotPath);
  const parsed = readSnapshot();
  anthillGraph.dict = parsed.graph.dict;
  anthillGraph.rootId = parsed.graph.rootId;
  anthillGraph.maxRelRootDepth = parsed.graph.maxRelRootDepth;
  anthillRootId = parsed.graph.rootId;
  maxRelRootDepth = parsed.graph.maxRelRootDepth;
  randomLeaf = parsed.randomLeaf;
  historyCache = parsed.history;
  replaceServe();
  console.log("Snapshot loaded: nodes =", Object.keys(anthillGraph.dict).length);
}

function readSnapshot(): Snapshot {
  return JSON.parse(readFileSync(snapshotPath, "utf8"), bigintReviver) as Snapshot;
}

let offchain: OffchainTree | undefined;
let auth: PasskeyAuth | undefined;

async function startOffchain() {
  const dataDir = process.env.DATA_DIR || join(process.cwd(), "data");
  const store = new Store(dataDir);
  console.log("Off-chain mode, data in", dataDir);

  // The snapshot's history leads up to the seeded state, so new steps continue
  // it.
  historyCache = { steps: [] };
  if (store.seed === undefined && store.actions.length === 0) {
    if (process.env.SEED !== "empty") {
      console.log("Seeding a new tree from", snapshotPath);
      store.setSeed(readSnapshot().graph);
    }
  }
  if (store.seed !== undefined) {
    historyCache = readSnapshot().history;
  }

  offchain = new OffchainTree(store);
  auth = new PasskeyAuth(store);

  await offchain.load(async (entry, events) => {
    await rebuildFromEngine(offchain!.engine);
    historyCache!.steps.push(historyStep(entry, events));
  });
  await rebuildFromEngine(offchain.engine);
  replaceServe();
  console.log(
    "Tree loaded: nodes =",
    Object.keys(anthillGraph.dict).length,
    "actions =",
    store.actions.length,
  );
}

// Recompute the served graph from the engine. The engine answers the same reads
// as the contract, so this reuses the chain loader.
async function rebuildFromEngine(engine: AnthillEngine) {
  const graph = {} as GraphData;
  await loadAnthillGraph(
    graph,
    [[]],
    0,
    engine as unknown as AnthillContractType,
    true,
  );
  const byDepth = [[]] as string[][];
  calculateDepthAndRelRoot(graph, byDepth);
  calculateReputation(graph, byDepth);

  anthillGraph.dict = graph.dict;
  anthillGraph.rootId = graph.rootId;
  anthillGraph.maxRelRootDepth = graph.maxRelRootDepth;
  anthillRootId = graph.rootId;
  maxRelRootDepth = graph.maxRelRootDepth;
  randomLeaf = findRandomLeaf(anthillGraph);
  anthillGraphNum += 1;
}

function historyStep(entry: ActionEntry, events: EngineEvent[]): HistoryStep {
  const args = entry.action.args as Record<string, string | undefined>;
  const index = historyCache?.steps.length ?? 0;
  return {
    index,
    eventName: events[events.length - 1]?.eventName ?? entry.action.fn,
    voter: entry.by,
    recipient: args.recipient ?? "",
    name: args.name ?? "",
    weight: args.weight ?? "0",
    blockNumber: index,
    nodes: snapshotNodes(anthillGraph),
  };
}

async function crawlEthereum(testing: boolean) {
  console.log("Loading graph (slowest part)");
  await loadAnthillGraph(
    anthillGraph,
    anthillGraphByDepth,
    anthillGraphNum,
    AnthillContract,
    testing,
  );
  console.log("Calculating depth");
  calculateDepthAndRelRoot(anthillGraph, anthillGraphByDepth);
  console.log("Calculating reputation");
  calculateReputation(anthillGraph, anthillGraphByDepth);
  console.log("Finding random leaf");
  randomLeaf = findRandomLeaf(anthillGraph);
  console.log("The found random leaf is: ", randomLeaf);
  anthillRootId = anthillGraph.rootId;
  maxRelRootDepth = anthillGraph.maxRelRootDepth;
  replaceServe();

  // One-off capture: build the history, write the frozen snapshot, and exit
  // (no event subscription needed). Run locally against the seeded anvil.
  if (captureSnapshot) {
    console.log("Capturing snapshot (building history)...");
    const history = await buildHistory(
      publicClient,
      anthillContractAddress,
      AnthillContract,
    );
    const snap: Snapshot = { graph: anthillGraph, history, randomLeaf };
    writeFileSync(snapshotPath, JSON.stringify(snap, bigintReplacer));
    console.log("Snapshot written to", snapshotPath, "— exiting.");
    process.exit(0);
  }

  // start subscription: watch all Anthill contract events and update the graph.
  publicClient.watchContractEvent({
    address: anthillContractAddress,
    abi: anthillAbi,
    onLogs: (logs) => {
      for (const log of logs) {
        handleLog(log as Log & { eventName?: string; args?: any });
      }

      anthillGraphByDepth = [[]] as string[][];

      calculateDepthAndRelRoot(anthillGraph, anthillGraphByDepth);
      calculateReputation(anthillGraph, anthillGraphByDepth);

      findRandomLeaf(anthillGraph);
      anthillGraphNum += 1;

      replaceServe();
    },
    onError: (error) => {
      console.log("we had some error in the eth subscription!", error);
    },
  });
}

function handleLog(log: Log & { eventName?: string; args?: any }) {
  console.log("received something");

  const eventName = log.eventName;
  const args = log.args ?? {};

  if (eventName === "JoinTreeEvent") {
    const { voter, name, recipient } = args;
    console.log("joinTreeEvent", voter, name, recipient);
    joinTree(anthillGraph, voter, name, recipient);
  } else if (eventName === "ChangeNameEvent") {
    const { voter, newName } = args;
    console.log("changeNameEvent", voter, newName);
    changeName(anthillGraph, voter, newName);
  } else if (eventName === "AddDagVoteEvent") {
    const { voter, recipient, weight } = args;
    console.log("addDagVoteEvent", voter, recipient, weight);
    addDagVote(anthillGraph, voter, recipient, weight);
  } else if (eventName === "RemoveDagVoteEvent") {
    const { voter, recipient } = args;
    console.log("removeDagVote", voter, recipient);
    removeDagVote(anthillGraph, voter, recipient);
  } else if (eventName === "LeaveTreeEvent") {
    const { voter } = args;
    console.log("leaveTreeEvent", voter);
    leaveTree(anthillGraph, voter);
  } else if (eventName === "SwitchPositionWithParentEvent") {
    const { voter } = args;
    console.log("switchPositionWithParentEvent", voter);
    switchPositionWithParent(anthillGraph, voter);
  } else if (eventName === "MoveTreeVoteEvent") {
    const { voter, recipient } = args;
    console.log("moveTreeVoteEvent", voter, recipient);
    moveTreeVote(anthillGraph, voter, recipient);
  }
}
