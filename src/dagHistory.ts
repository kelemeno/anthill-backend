import type { Address } from "viem";
import { anthillAbi } from "./anthillContract";
import type { AnthillContractType } from "./anthillContract";
import {
  addDagVote,
  address0,
  address1,
  changeName,
  type GraphData,
  joinTree,
  leaveTree,
  moveTreeVote,
  type NodeDataStore,
  removeDagVote,
  switchPositionWithParent,
} from "./dagBase";
import { resetIntermediate } from "./dagLoading";
import { calculateDepthAndRelRoot, calculateReputation } from "./dagProcessing";

// A single node as captured in a history snapshot.
export type HistoryNode = {
  id: string;
  name: string;
  currentRep: string;
  depth: number;
  sentTreeVote: string;
  recTreeVotes: string[];
  dagVotes: string[];
};

// A single step of the timeline: the graph state right after applying one event.
export type HistoryStep = {
  index: number;
  eventName: string;
  voter: string;
  recipient: string;
  name: string;
  weight: string;
  blockNumber: number;
  nodes: HistoryNode[];
};

export type History = {
  steps: HistoryStep[];
};

type MinimalPublicClient = {
  getContractEvents: (args: {
    address: Address;
    abi: typeof anthillAbi;
    fromBlock: bigint;
    toBlock: "latest";
  }) => Promise<unknown[]>;
};

type DecodedEvent = {
  eventName?: string;
  args?: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
};

// Build a fresh empty graph that has the same initial structure the live loader
// relies on (the address1 sentinel from resetIntermediate, plus the contract's
// root node hung off address1). The mutation functions require this structure.
async function initEmptyGraph(
  AnthillContract: AnthillContractType,
): Promise<GraphData> {
  const dag = {} as GraphData;
  resetIntermediate(dag);
  dag.maxRelRootDepth = Number(await AnthillContract.read.MAX_REL_ROOT_DEPTH());

  const rootId: string = await AnthillContract.read.root();
  dag.rootId = rootId;

  // The root predates the event log (it is never created by a JoinTreeEvent),
  // so we seed it the same way loadAnthillGraph does, but with no votes yet.
  const node = {
    id: rootId,
    name: await AnthillContract.read.nameOf([rootId as Address]),
    totalWeight: 0n,
    currentRep: 0n,
    depth: 0,
    relRoot: rootId,
    sentTreeVote: address1,
    recTreeVotes: [],
    sentDagVotes: [],
    recDagVotes: [],
  } as NodeDataStore;
  dag.dict[rootId] = node;
  dag.dict[address1].recTreeVotes.push(rootId);

  return dag;
}

// Apply a single decoded event to the graph, using the same event->mutation
// mapping as App.ts handleLog.
//
// Note: when a voter joins, the contract emits the join's weight-1 dag vote as a
// standalone AddDagVoteEvent that precedes the JoinTreeEvent. joinTree() already
// performs that addDagVote internally, so we skip a standalone AddDagVoteEvent
// whose voter does not exist yet (it belongs to the upcoming join).
function applyEvent(dag: GraphData, eventName: string, args: any) {
  if (eventName === "JoinTreeEvent") {
    const { voter, name, recipient } = args;
    joinTree(dag, voter, name, recipient);
  } else if (eventName === "ChangeNameEvent") {
    const { voter, newName } = args;
    changeName(dag, voter, newName);
  } else if (eventName === "AddDagVoteEvent") {
    const { voter, recipient, weight } = args;
    if (dag.dict[voter] === undefined) {
      // join-paired vote; joinTree will add it.
      return;
    }
    addDagVote(dag, voter, recipient, weight);
  } else if (eventName === "RemoveDagVoteEvent") {
    const { voter, recipient } = args;
    removeDagVote(dag, voter, recipient);
  } else if (eventName === "LeaveTreeEvent") {
    const { voter } = args;
    leaveTree(dag, voter);
  } else if (eventName === "SwitchPositionWithParentEvent") {
    const { voter } = args;
    switchPositionWithParent(dag, voter);
  } else if (eventName === "MoveTreeVoteEvent") {
    const { voter, recipient } = args;
    moveTreeVote(dag, voter, recipient);
  }
}

function snapshotNodes(dag: GraphData): HistoryNode[] {
  const nodes: HistoryNode[] = [];
  for (const id of Object.keys(dag.dict)) {
    // exclude the sentinels.
    if (id === address0 || id === address1) {
      continue;
    }
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

function asString(v: unknown): string {
  if (v === undefined || v === null) {
    return "";
  }
  return String(v);
}

// Replay every past on-chain event from an empty graph, capturing a full
// snapshot after each event. Returns the complete timeline.
export async function buildHistory(
  publicClient: MinimalPublicClient,
  anthillContractAddress: Address,
  AnthillContract: AnthillContractType,
): Promise<History> {
  const rawEvents = (await publicClient.getContractEvents({
    address: anthillContractAddress,
    abi: anthillAbi,
    fromBlock: 0n,
    toBlock: "latest",
  })) as DecodedEvent[];

  const events = [...rawEvents].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) {
      return a.blockNumber < b.blockNumber ? -1 : 1;
    }
    return a.logIndex - b.logIndex;
  });

  const dag = await initEmptyGraph(AnthillContract);

  const steps: HistoryStep[] = [];
  let index = 0;

  for (const event of events) {
    const eventName = event.eventName ?? "";
    const args = (event.args ?? {}) as Record<string, unknown>;

    applyEvent(dag, eventName, args);

    // recompute depth + relRoot + reputation exactly as the live code does.
    const byDepth = [[]] as string[][];
    calculateDepthAndRelRoot(dag, byDepth);
    calculateReputation(dag, byDepth);

    steps.push({
      index,
      eventName,
      voter: asString(args.voter),
      recipient: asString(args.recipient),
      name: asString(args.name ?? args.newName),
      weight: args.weight === undefined ? "0" : asString(args.weight),
      blockNumber: Number(event.blockNumber),
      nodes: snapshotNodes(dag),
    });

    index += 1;
  }

  return { steps };
}
