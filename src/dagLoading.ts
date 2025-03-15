import {
  address0,
  address1,
  GraphData,
  DagVote,
  NodeDataStore,
  GraphDataDict,
  initialiseDagArray,
} from "./dagBase";
import { Anthill } from "./typechain";

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
  AnthillContract: Anthill,
  id: string,
  timeout: number,
): Promise<DagVote[][][]> {
  var dagVotes = initialiseDagArray(maxRelRootDepth);

  await delay(timeout);
  let sentDagVoteCount = await AnthillContract.sentDagVoteCount(id);
  for (var j = 0; j < sentDagVoteCount; j++) {
    await delay(timeout);
    var sDagVote = await AnthillContract.sentDagVote(id, j);
    if (sDagVote.id == address0) {
      continue;
    }
    var rDagVote = await AnthillContract.recDagVote(sDagVote.id, sDagVote.posInOther);
    const dist = Number(sDagVote.dist);
    const depth = dist - Number(rDagVote.dist);
    dagVotes[dist][depth].push({
      id: sDagVote.id,
      weight: sDagVote.weight,
      dist: Number(sDagVote.dist),
      posInOther: Number(sDagVote.posInOther),
    });
  }

  return dagVotes;
}

export async function getRecDagVotes(
  maxRelRootDepth: number,
  AnthillContract: Anthill,
  id: string,
  timeout: number,
): Promise<DagVote[][][]> {
  let dagVotes = initialiseDagArray(maxRelRootDepth);

  await delay(timeout);
  let recDagVoteCount = await AnthillContract.recDagVoteCount(id);
  for (var j = 0; j < recDagVoteCount; j++) {
    await delay(timeout);
    var rDagVote = await AnthillContract.recDagVote(id, j);

    if (rDagVote.id == address0) {
      continue;
    }
    let sDagVote = await AnthillContract.sentDagVote(rDagVote.id, rDagVote.posInOther);
    const depth = Number(sDagVote.dist) - Number(rDagVote.dist);
    dagVotes[Number(sDagVote.dist)][depth].push({
      id: rDagVote.id,
      weight: rDagVote.weight,
      posInOther: Number(rDagVote.posInOther),
      dist: Number(sDagVote.dist),
    });
  }

  return dagVotes;
}

export async function getSaveChildren(
  dag: GraphData,
  AnthillContract: Anthill,
  id: string,
  timeout: number,
) {
  console.log("Getting voter with address: " + id);
  var childCount = await AnthillContract.recTreeVoteCount(id);
  for (var i = 0; i < childCount; i++) {
    var childId = await AnthillContract.recTreeVote(id, i);

    var sentDagVotes: DagVote[][][] = await getSentDagVotes(
      dag.maxRelRootDepth,
      AnthillContract,
      childId,
      timeout,
    );
    var recDagVotes: DagVote[][][] = await getRecDagVotes(
      dag.maxRelRootDepth,
      AnthillContract,
      childId,
      timeout,
    );
    var onChainRep = await AnthillContract.calculatedReputationForEpoch(childId);
    await delay(timeout);
    var name = await AnthillContract.nameOf(childId);
    await delay(timeout);
    var totalWeight = await AnthillContract.sentDagVoteTotalWeight(childId);

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
  AnthillContract: Anthill,
  testing: boolean,
) {
  var timeout = 40;
  if (testing) {
    timeout = 0;
  }

  resetIntermediate(dag);

  dag.maxRelRootDepth = Number(await AnthillContract.MAX_REL_ROOT_DEPTH());

  console.log("MaxRelRootDepth is: " + dag.maxRelRootDepth);
  anthillGraphNum += 1;

  var id: string = await AnthillContract.root();
  dag.rootId = id;
  console.log("Root is: " + id);
  var onChainRep = await AnthillContract.calculatedReputationForEpoch(id);
  var name = await AnthillContract.nameOf(id);
  var sentTreeVote = await AnthillContract.sentTreeVote(id);
  // the root has no sentDagVotes, so we don't read that.
  var recDagVotes: DagVote[][][] = await getRecDagVotes(
    dag.maxRelRootDepth,
    AnthillContract,
    id,
    timeout,
  );
  var totalWeight = await AnthillContract.sentDagVoteTotalWeight(id);

  var node = {
    id: id,
    name: name,
    totalWeight: totalWeight,
    currentRep: 0n,
    depth: 0,
    relRoot: "",
    sentTreeVote: sentTreeVote,
    recTreeVotes: [],
    sentDagVotes: initialiseDagArray(dag.maxRelRootDepth),
    recDagVotes: recDagVotes,
  } as NodeDataStore;
  dag.dict[id] = node;
  dag.dict[address1].recTreeVotes.push(id);

  await getSaveChildren(dag, AnthillContract, id, timeout);
}
