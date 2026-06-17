import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { WSContext } from "hono/ws";
import type { Address, Log } from "viem";
import {
  anthillAbi,
  makeAnthillContract,
  makePublicClient,
} from "./anthillContract";
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
    allowHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept"],
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

app.get("/randomLeaf", (c) => {
  console.log("getting random leaf");

  return c.json({ randomLeaf: randomLeafServe });
});

const server = serve(
  {
    fetch: app.fetch,
    port: Number(port),
  },
  () => {
    console.log(`WebSocket and http server is running on port ${port}`);
    crawlEthereum(testing);
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

const testing = true;

if (testing) {
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
