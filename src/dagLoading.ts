import type { Address } from "viem";
import type { AnthillContractType } from "./anthillContract";
import {
  address0,
  address1,
  type DagVote,
  type GraphData,
  type GraphDataDict,
  type NodeDataStore,
} from "./dagBase";

function addr(id: string): Address {
  return id as Address;
}

export function resetIntermediate(dag: GraphData) {
  const emptyDict = {} as GraphDataDict;

  dag.rootId = address0;
  dag.maxRelRootDepth = 6;
  dag.dict = emptyDict;
  var node1 = {
    id: address1,
    depth: -1,
    relRoot: address1,
    sentTreeVote: address1,
    recTreeVotes: [],
    recDagVotes: [],
    sentDagVotes: [],
    currentRep: 0n,
    totalWeight: 0n,
    name: "",
    reputation: 0n,
  };
  dag.dict[address1] = node1;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getSentDagVotes(
  maxRelRootDepth: number,
  AnthillContract: AnthillContractType,
  id: string,
  timeout: number,
): Promise<DagVote[]> {
  var dagVotes: DagVote[] = [];

  await delay(timeout);
  const sentDagVoteCount = await AnthillContract.read.sentDagVoteCount([
    addr(id),
  ]);
  for (var j = 0; j < sentDagVoteCount; j++) {
    await delay(timeout);
    var sDagVote = await AnthillContract.read.sentDagVote([
      addr(id),
      BigInt(j),
    ]);
    var [sId, sWeight, sDist, sPosInOther] = sDagVote;
    if (sId == address0) {
      continue;
    }
    var rDagVote = await AnthillContract.read.recDagVote([sId, sPosInOther]);
    var [, , rDist] = rDagVote;
    const dist = Number(sDist);
    const depth = dist - Number(rDist);
    dagVotes.push({
      id: sId,
      weight: sWeight,
      dist: Number(sDist),
      posInOther: Number(sPosInOther),
    });
  }

  return dagVotes;
}

export async function getRecDagVotes(
  maxRelRootDepth: number,
  AnthillContract: AnthillContractType,
  id: string,
  timeout: number,
): Promise<DagVote[]> {
  var dagVotes: DagVote[] = [];

  await delay(timeout);
  const recDagVoteCount = await AnthillContract.read.recDagVoteCount([
    addr(id),
  ]);
  for (var j = 0; j < recDagVoteCount; j++) {
    await delay(timeout);
    var rDagVote = await AnthillContract.read.recDagVote([addr(id), BigInt(j)]);
    var [rId, rWeight, , rPosInOther] = rDagVote;

    if (rId == address0) {
      continue;
    }
    const sDagVote = await AnthillContract.read.sentDagVote([rId, rPosInOther]);
    var [, , sDist] = sDagVote;
    dagVotes.push({
      id: rId,
      weight: rWeight,
      posInOther: Number(rPosInOther),
      dist: Number(sDist),
    });
  }

  return dagVotes;
}

export async function getSaveChildren(
  dag: GraphData,
  AnthillContract: AnthillContractType,
  id: string,
  timeout: number,
) {
  console.log("Getting voter with address: " + id);
  var childCount = await AnthillContract.read.recTreeVoteCount([addr(id)]);
  for (var i = 0n; i < childCount; i++) {
    var childId = await AnthillContract.read.recTreeVote([addr(id), i]);

    var sentDagVotes: DagVote[] = await getSentDagVotes(
      dag.maxRelRootDepth,
      AnthillContract,
      childId,
      timeout,
    );
    var recDagVotes: DagVote[] = await getRecDagVotes(
      dag.maxRelRootDepth,
      AnthillContract,
      childId,
      timeout,
    );
    var onChainRep = await AnthillContract.read.calculatedReputationForEpoch([
      childId,
    ]);
    await delay(timeout);
    var name = await AnthillContract.read.nameOf([childId]);
    await delay(timeout);
    var totalWeight = await AnthillContract.read.sentDagVoteTotalWeight([
      childId,
    ]);

    var childNode = {
      id: childId,
      name: name,
      totalWeight: totalWeight,
      currentRep: 0n,
      depth: 0,
      relRoot: "",
      sentTreeVote: id,
      recTreeVotes: [],
      sentDagVotes: sentDagVotes,
      recDagVotes: recDagVotes,
    } as NodeDataStore;
    dag.dict[childId] = childNode;

    // we push the children here instead of in the childnode initialisation above, as we are already crawling the tree.
    dag.dict[id].recTreeVotes.push(childId);

    await getSaveChildren(dag, AnthillContract, childId, timeout);
  }
}

export async function loadAnthillGraph(
  dag: GraphData,
  depthA: string[][],
  anthillGraphNum: number,
  AnthillContract: AnthillContractType,
  testing: boolean,
) {
  var timeout = 40;
  if (testing) {
    timeout = 0;
  }

  resetIntermediate(dag);

  dag.maxRelRootDepth = Number(await AnthillContract.read.MAX_REL_ROOT_DEPTH());

  console.log("MaxRelRootDepth is: " + dag.maxRelRootDepth);
  anthillGraphNum += 1;

  var id: string = await AnthillContract.read.root();
  dag.rootId = id;
  console.log("Root is: " + id);
  var onChainRep = await AnthillContract.read.calculatedReputationForEpoch([
    addr(id),
  ]);
  var name = await AnthillContract.read.nameOf([addr(id)]);
  var sentTreeVote = await AnthillContract.read.sentTreeVote([addr(id)]);
  // the root has no sentDagVotes, so we don't read that.
  var recDagVotes: DagVote[] = await getRecDagVotes(
    dag.maxRelRootDepth,
    AnthillContract,
    id,
    timeout,
  );
  var totalWeight = await AnthillContract.read.sentDagVoteTotalWeight([
    addr(id),
  ]);

  var node = {
    id: id,
    name: name,
    totalWeight: totalWeight,
    currentRep: 0n,
    depth: 0,
    relRoot: "",
    sentTreeVote: sentTreeVote,
    recTreeVotes: [],
    sentDagVotes: [],
    recDagVotes: recDagVotes,
  } as NodeDataStore;
  dag.dict[id] = node;
  dag.dict[address1].recTreeVotes.push(id);

  await getSaveChildren(dag, AnthillContract, id, timeout);
}
