// this is modification of the solidity code
// the functions are not mirrors, as here the data is proceseed, so we can do more (this might change in the future, e.g. we might add depth)

import assert from "assert";

export type DagVote = {
  id: string;
  weight: bigint;
  dist: number;
  posInOther: number;
};
export type DagVoteString = {
  id: string;
  weight: string;
  dist: number;
  posInOther: number;
};

export function dagVoteString(dagVote: DagVote): DagVoteString {
  return {
    id: dagVote.id,
    weight: dagVote.weight.toString(),
    dist: dagVote.dist,
    posInOther: dagVote.posInOther,
  };
}

export type NodeDataStore = {
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

export type GraphDataDict = { [id: string]: NodeDataStore };
export type GraphData = {
  rootId: string;
  maxRelRootDepth: number;
  dict: GraphDataDict;
};

export const address0 = "0x0000000000000000000000000000000000000000";
export const address1 = "0x0000000000000000000000000000000000000001";

///////////////////
////// Update

export function joinTree(
  dag: GraphData,
  voter: string,
  name: string,
  recipient: string,
) {
  // todo sanitity check
  if (dag.dict[voter] == undefined) {
    // error we need to reload the graph
  }

  dag.dict[voter] = {
    id: voter,
    name: name,
    totalWeight: 0n,
    currentRep: 0n,
    depth: 0,
    relRoot: voter,
    sentTreeVote: recipient,
    recTreeVotes: [],
    sentDagVotes: [],
    recDagVotes: [],
  } as NodeDataStore;
  dag.dict[voter].sentTreeVote = recipient;
  dag.dict[recipient].recTreeVotes.push(voter);

  dag.dict[voter].name = name;
  dag.dict[voter].id = voter;

  addDagVote(dag, voter, recipient, 1n);
}

export function changeName(dag: GraphData, voter: string, newName: string) {
  // todo a sanity check
  dag.dict[voter].name = newName;
}

export function addDagVote(
  dag: GraphData,
  voter: string,
  recipient: string,
  weight: bigint,
) {
  // todo sanity check
  var [, dist, depth] = findDistDepth(dag, voter, recipient);
  combinedDagAppendSDist(dag, voter, recipient, dist, depth, weight);
}

export function removeDagVote(
  dag: GraphData,
  voter: string,
  recipient: string,
) {
  // sanity check that we have the voter recipient
  var [, dist, depth] = findDistDepth(dag, voter, recipient);
  for (
    var count = dag.dict[voter].sentDagVotes.length - 1;
    0 <= count;
    count--
  ) {
    if (dag.dict[voter].sentDagVotes[count].id == recipient) {
      safeRemoveSentDagVoteDistDepthPos(dag, voter, count);
      return;
    }
  }
  // we did not find voter, we need to reload the graph.
}

export function leaveTree(dag: GraphData, voter: string) {
  // remove dag connections
  // todo specify the dist and depth
  for (let i = dag.dict[voter].sentDagVotes.length - 1; i >= 0; i--) {
    safeRemoveSentDagVoteDistDepthPos(dag, voter, i);
  }

  for (let i = dag.dict[voter].recDagVotes.length - 1; i >= 0; i--) {
    safeRemoveRecDagVoteDistDepthPos(dag, voter, i);
  }

  handleLeavingVoterBranch(dag, voter);
  delete dag.dict[voter];
}

export function switchPositionWithParent(dag: GraphData, voter: string) {
  var parent = dag.dict[voter].sentTreeVote;
  assert(parent != address0);
  assert(parent != address1);
  assert(parent != undefined);
  var gparent = dag.dict[parent].sentTreeVote;

  handleDagVoteReplace(dag, parent, parent, voter, 0, 0);
  handleDagVoteReplace(dag, voter, gparent, parent, 2, 2);

  switchTreeVoteWithParent(dag, voter);
}

export function moveTreeVote(dag: GraphData, voter: string, recipient: string) {
  var dist, depth, bool;
  if (dag.dict[voter].depth > dag.dict[recipient].depth) {
    [bool, dist, depth] = findDistDepth(dag, voter, recipient);
  } else {
    var opDepth, opDist;
    [bool, opDist, opDepth] = findDistDepth(dag, recipient, voter);
    depth = -opDepth;
    dist = opDist - opDepth;
  }

  // we need to leave the tree now so that our descendants can rise.
  var parent = dag.dict[voter].sentTreeVote;
  handleLeavingVoterBranch(dag, voter);

  if (dist == 0) {
    // if we are jumping to our descendant who just rose, we have to modify the lowerSDist
    if (findNthParent(dag, recipient, -depth) == parent) {
      depth = depth + 1;
    }
  }

  // we move to an empty position so replaced address is always 0.
  handleDagVoteReplace(dag, voter, recipient, address0, dist, depth);

  // handle tree votes
  // there is a single twist here, if recipient is the descendant of the voter that rises.
  addTreeVote(dag, voter, recipient);
}

/////////////
////// treeVotes
function removeTreeVote(dag: GraphData, voter: string) {
  var parent = dag.dict[voter].sentTreeVote;
  dag.dict[voter].sentTreeVote = address1;
  dag.dict[parent].recTreeVotes.forEach((childId, index) => {
    // note we don't just filter, as we keep the order the same as it is on chain.
    if (childId == voter) {
      dag.dict[parent].recTreeVotes[index] =
        dag.dict[parent].recTreeVotes[dag.dict[parent].recTreeVotes.length - 1];
      dag.dict[parent].recTreeVotes.pop();
      return;
    }
  });
  // there was an error, panic.
}

function addTreeVote(dag: GraphData, voter: string, recipient: string) {
  dag.dict[voter].sentTreeVote = recipient;
  dag.dict[recipient].recTreeVotes.push(voter);
}

function switchTreeVoteWithParent(dag: GraphData, voter: string) {
  var parent = dag.dict[voter].sentTreeVote;
  assert(parent != address0);
  assert(parent != address1);
  assert(parent !== undefined);

  var gparent = dag.dict[parent].sentTreeVote; // this can be 1.

  removeTreeVote(dag, voter);

  if (dag.rootId == parent) {
    dag.rootId = voter;
  }

  removeTreeVote(dag, parent);

  var brother = dag.dict[parent].recTreeVotes[0];

  var child1 = dag.dict[voter].recTreeVotes[0];
  var child2 = dag.dict[voter].recTreeVotes[1];

  addTreeVote(dag, voter, gparent);
  addTreeVote(dag, parent, voter);

  if (brother != address0 && brother !== undefined) {
    removeTreeVote(dag, brother);
    addTreeVote(dag, brother, voter);
  }

  if (child1 != address0 && child1 !== undefined) {
    removeTreeVote(dag, child1);
    addTreeVote(dag, child1, parent);
  }

  if (child2 != address0 && child2 !== undefined) {
    removeTreeVote(dag, child2);
    addTreeVote(dag, child2, parent);
  }
}

function pullUpBranch(dag: GraphData, pulledVoter: string, parent: string) {
  var firstChild = dag.dict[pulledVoter].recTreeVotes[0];
  var secondChild = dag.dict[pulledVoter].recTreeVotes[1];

  if (firstChild != address0 && firstChild !== undefined) {
    handleDagVoteReplace(dag, firstChild, parent, pulledVoter, 2, 2);

    pullUpBranch(dag, firstChild, pulledVoter);

    if (secondChild != address0 && secondChild !== undefined) {
      removeTreeVote(dag, secondChild);
      addTreeVote(dag, secondChild, firstChild);
    }
  }
}

function handleLeavingVoterBranch(dag: GraphData, voter: string) {
  var parent = dag.dict[voter].sentTreeVote;

  var firstChild = dag.dict[voter].recTreeVotes[0];
  var secondChild = dag.dict[voter].recTreeVotes[1];

  if (firstChild != address0 && firstChild !== undefined) {
    handleDagVoteReplace(dag, firstChild, parent, voter, 2, 2);

    pullUpBranch(dag, firstChild, voter);

    if (secondChild != address0 && secondChild !== undefined) {
      removeTreeVote(dag, secondChild);
      addTreeVote(dag, secondChild, firstChild);
    }

    removeTreeVote(dag, firstChild);
    addTreeVote(dag, firstChild, parent);
  }

  removeTreeVote(dag, voter);
  dag.dict[voter].sentTreeVote = address1;

  if (dag.rootId == voter) {
    dag.rootId = firstChild;
  }
}

///////////////////
////// DagVotes
function handleDagVoteReplace(
  dag: GraphData,
  voterWithChangingDagVotes: string,
  recipient: string,
  replacedPositionInTree: string,
  moveDist: number,
  heightToRec: number,
) {
  const temp = "0x9999999999999999999999999999999999999999";

  if (replacedPositionInTree == address0) {
    dag.dict[temp] = {
      id: temp,
      sentTreeVote: address1,
      recTreeVotes: [],
      sentDagVotes: [],
      recDagVotes: [],
      totalWeight: 0n,
      currentRep: 0n,
      depth: 0,
      relRoot: temp,
      name: "",
    };
    addTreeVote(dag, temp, recipient);
    replacedPositionInTree = temp;
  }

  // Handle sent votes
  for (
    let i = dag.dict[voterWithChangingDagVotes].sentDagVotes.length;
    0 < i;
    --i
  ) {
    const sDagVote = dag.dict[voterWithChangingDagVotes].sentDagVotes[i - 1];
    const [isLocal, sDist, rDist] = findDistDepth(
      dag,
      replacedPositionInTree,
      sDagVote.id,
    );

    if (!isLocal || sDist == rDist) {
      safeRemoveSentDagVoteDistDepthPos(dag, voterWithChangingDagVotes, i - 1);
    } else {
      dag.dict[voterWithChangingDagVotes].sentDagVotes[i - 1].dist = sDist;
      dag.dict[sDagVote.id].recDagVotes[sDagVote.posInOther].dist = rDist;
    }
  }

  // Handle received votes
  for (
    let i = dag.dict[voterWithChangingDagVotes].recDagVotes.length;
    0 < i;
    --i
  ) {
    const rDagVote = dag.dict[voterWithChangingDagVotes].recDagVotes[i - 1];
    const [isLocal, sDist, rDist] = findDistDepth(
      dag,
      rDagVote.id,
      replacedPositionInTree,
    );

    if (!isLocal || sDist == rDist) {
      safeRemoveRecDagVoteDistDepthPos(dag, voterWithChangingDagVotes, i - 1);
    } else {
      dag.dict[voterWithChangingDagVotes].recDagVotes[i - 1].dist = rDist;
      dag.dict[rDagVote.id].sentDagVotes[rDagVote.posInOther].dist = sDist;
    }
  }

  if (replacedPositionInTree == temp) {
    removeTreeVote(dag, temp);
    delete dag.dict[temp];
  }
}

///////////////////

function unsafeReplaceSentDagVoteAtDistDepthPosWithLast(
  dag: GraphData,
  voter: string,
  sPos: number,
) {
  // find the vote we delete
  var sDagVote = dag.dict[voter].sentDagVotes[sPos];
  dag.dict[voter].totalWeight -= sDagVote.weight;

  if (sPos != dag.dict[voter].sentDagVotes.length - 1) {
    // if we delete a vote in the middle, we need to copy the last vote to the deleted position
    var copiedSentDagVote =
      dag.dict[voter].sentDagVotes[dag.dict[voter].sentDagVotes.length - 1];
    dag.dict[voter].sentDagVotes[sPos] = copiedSentDagVote;
    dag.dict[copiedSentDagVote.id].recDagVotes[
      copiedSentDagVote.posInOther
    ].posInOther = sPos;
  }

  // delete the potentially copied hence duplicate last vote
  dag.dict[voter].sentDagVotes.pop();
}

function unsafeReplaceRecDagVoteAtDistDepthPosWithLast(
  dag: GraphData,
  recipient: string,
  rPos: number,
) {
  if (rPos != dag.dict[recipient].recDagVotes.length - 1) {
    // if we delete a vote in the middle, we need to copy the last vote to the deleted position
    var copiedSentDagVote =
      dag.dict[recipient].recDagVotes[
        dag.dict[recipient].recDagVotes.length - 1
      ];
    dag.dict[recipient].recDagVotes[rPos] = copiedSentDagVote;
    dag.dict[copiedSentDagVote.id].sentDagVotes[
      copiedSentDagVote.posInOther
    ].posInOther = rPos;
  }

  // delete the potentially copied hence duplicate last vote
  dag.dict[recipient].recDagVotes.pop();
}

function safeRemoveSentDagVoteDistDepthPos(
  dag: GraphData,
  voter: string,
  sPos: number,
) {
  var sDagVote = dag.dict[voter].sentDagVotes[sPos];
  unsafeReplaceSentDagVoteAtDistDepthPosWithLast(dag, voter, sPos);
  // delete the opposite
  unsafeReplaceRecDagVoteAtDistDepthPosWithLast(
    dag,
    sDagVote.id,
    sDagVote.posInOther,
  );
}

function safeRemoveRecDagVoteDistDepthPos(
  dag: GraphData,
  recipient: string,
  rPos: number,
) {
  var rDagVote = dag.dict[recipient].recDagVotes[rPos];
  unsafeReplaceRecDagVoteAtDistDepthPosWithLast(dag, recipient, rPos);
  // delete the opposite
  unsafeReplaceSentDagVoteAtDistDepthPosWithLast(
    dag,
    rDagVote.id,
    rDagVote.posInOther,
  );
}

function combinedDagAppendSDist(
  dag: GraphData,
  voter: string,
  recipient: string,
  sdist: number,
  depth: number,
  weight: bigint,
) {
  var rdist = sdist - depth;

  var sLen = dag.dict[voter].sentDagVotes.length;
  var rLen = dag.dict[recipient].recDagVotes.length;

  dag.dict[voter].sentDagVotes.push({
    id: recipient,
    weight: weight,
    posInOther: rLen,
    dist: sdist,
  });
  dag.dict[voter].totalWeight += weight;
  dag.dict[recipient].recDagVotes.push({
    id: voter,
    weight: weight,
    posInOther: sLen,
    dist: rdist,
  });
}

/////////////

function findDepth(dag: GraphData, voter: string): number {
  if (voter == address0) {
    throw "findDepth of address0";
  }
  if (voter == address1) {
    return -1;
  }
  if (voter == dag.rootId) {
    return 0;
  }

  return findDepth(dag, dag.dict[voter].sentTreeVote) + 1;
}

function findDepthDiff(
  dag: GraphData,
  voter: string,
  recipient: string,
): number {
  if (recipient == dag.rootId) {
    return findDepth(dag, voter);
  }
  if (voter == dag.rootId) {
    return -findDepth(dag, recipient);
  }

  return findDepthDiff(
    dag,
    dag.dict[voter].sentTreeVote,
    dag.dict[recipient].sentTreeVote,
  );
}

// rec has to be higher than voter.
function findDistDepth(
  dag: GraphData,
  voter: string,
  recipient: string,
): [boolean, number, number] {
  var depthDiff = findDepthDiff(dag, voter, recipient);

  var anscestor = findNthParent(dag, voter, depthDiff);
  var [sameDepth, dist] = findDistAtSameDepth(dag, anscestor, recipient);
  return [sameDepth, dist + depthDiff, depthDiff];
}

function findDistAtSameDepth(
  dag: GraphData,
  add1: string,
  add2: string,
): [boolean, number] {
  if (add1 == add2) {
    return [true, 0];
  }

  if (
    dag.dict[add1].sentTreeVote == address0 ||
    dag.dict[add2].sentTreeVote == address0
  ) {
    return [false, 0];
  }

  if (
    dag.dict[add1].sentTreeVote == address1 ||
    dag.dict[add2].sentTreeVote == address1
  ) {
    return [false, 0];
  }

  var [isSameDepth, distance] = findDistAtSameDepth(
    dag,
    dag.dict[add1].sentTreeVote,
    dag.dict[add2].sentTreeVote,
  );

  if (isSameDepth == true) {
    return [true, distance + 1];
  }

  return [false, 0];
}

function findNthParent(dag: GraphData, voter: string, height: number): string {
  if (height == 0) {
    return voter;
  }
  if (dag.dict[voter].sentTreeVote == address1) {
    return address1;
  }

  // this should never be the case, but it is a safety check
  assert(dag.dict[voter].sentTreeVote != address0);

  return findNthParent(dag, dag.dict[voter].sentTreeVote, height - 1);
}
