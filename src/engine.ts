// Off-chain port of anthill-contracts/src/Anthill.sol.
//
// This mirrors the contract's storage layout and logic line by line, so the same
// sequence of calls produces the same state (including vote array order and
// posInOther). A failed `require` throws a Revert and `run` rolls the whole call
// back, like a reverted transaction. uint256 subtraction is checked, as in
// Solidity >=0.8.
//
// Differences from the contract:
// - no `onlyVoter`/`unlocked`: the server authenticates the voter instead, and
//   the internal `check(unlocked)` checks are treated as always passing (the
//   deployed tree was never locked).
// - only the functions the app calls (plus the getters dagLoading reads) are
//   ported.
//
// If you change Anthill.sol, change this file the same way and rerun
// scripts/diffEngine.ts, which replays random actions against both.

export const address0 = "0x0000000000000000000000000000000000000000";
export const address1 = "0x0000000000000000000000000000000000000001";
const tempAddress = "0x0000000000000000000000000000000099999999";

const MAX_REL_ROOT_DEPTH = 6;
const decimalPoint = 18n;

export type EngineDagVote = {
  id: string;
  weight: bigint;
  dist: number;
  posInOther: number;
};

export type EngineEvent =
  | { eventName: "JoinTreeEvent"; voter: string; name: string; recipient: string }
  | { eventName: "ChangeNameEvent"; voter: string; newName: string }
  | { eventName: "AddDagVoteEvent"; voter: string; recipient: string; weight: bigint }
  | { eventName: "RemoveDagVoteEvent"; voter: string; recipient: string }
  | { eventName: "LeaveTreeEvent"; voter: string }
  | { eventName: "SwitchPositionWithParentEvent"; voter: string }
  | { eventName: "MoveTreeVoteEvent"; voter: string; recipient: string };

export class Revert extends Error {}

// Solidity's require.
function check(condition: boolean, reason: string): asserts condition {
  if (!condition) {
    throw new Revert(reason);
  }
}

function sub(a: number, b: number): number {
  check(b <= a, "panic: arithmetic underflow");
  return a - b;
}

function subBig(a: bigint, b: bigint): bigint {
  check(b <= a, "panic: arithmetic underflow");
  return a - b;
}

function zeroVote(): EngineDagVote {
  return { id: address0, weight: 0n, dist: 0, posInOther: 0 };
}

type State = {
  nameOf: Map<string, string>;
  sentTreeVote: Map<string, string>;
  recTreeVoteCount: Map<string, number>;
  recTreeVote: Map<string, Map<number, string>>;
  sentDagVoteCount: Map<string, number>;
  sentDagVote: Map<string, Map<number, EngineDagVote>>;
  sentDagVoteTotalWeight: Map<string, bigint>;
  recDagVoteCount: Map<string, number>;
  recDagVote: Map<string, Map<number, EngineDagVote>>;
  reputationEpoch: bigint;
  calculatedReputationForEpoch: Map<string, bigint>;
  reputation: Map<string, bigint>;
};

function emptyState(): State {
  return {
    nameOf: new Map(),
    sentTreeVote: new Map(),
    recTreeVoteCount: new Map(),
    recTreeVote: new Map(),
    sentDagVoteCount: new Map(),
    sentDagVote: new Map(),
    sentDagVoteTotalWeight: new Map(),
    recDagVoteCount: new Map(),
    recDagVote: new Map(),
    reputationEpoch: 0n,
    calculatedReputationForEpoch: new Map(),
    reputation: new Map(),
  };
}

// The graph shape the seed is read from (dagBase GraphData, as stored in
// anthillSnapshot.json). Note dagLoading stores the *sender's* dist on received
// votes, so the recipient-side dist is recomputed when seeding.
export type SeedGraph = {
  rootId: string;
  dict: {
    [id: string]: {
      id: string;
      name: string;
      totalWeight: bigint;
      sentTreeVote: string;
      recTreeVotes: string[];
      sentDagVotes: { id: string; weight: bigint; dist: number; posInOther: number }[];
      recDagVotes: { id: string; weight: bigint; dist: number; posInOther: number }[];
    };
  };
};

export class AnthillEngine {
  private s: State = emptyState();
  private events: EngineEvent[] = [];

  // Run one state-changing call atomically: on a Revert (or any other error)
  // the state is restored and the error rethrown. Returns the emitted events.
  run(call: (engine: AnthillEngine) => void): EngineEvent[] {
    const backup = structuredClone(this.s);
    this.events = [];
    try {
      call(this);
    } catch (e) {
      this.s = backup;
      this.events = [];
      throw e;
    }
    const emitted = this.events;
    this.events = [];
    return emitted;
  }

  // Run a call and always roll it back: a dry run that throws exactly when the
  // real call would.
  simulate(call: (engine: AnthillEngine) => void) {
    const backup = structuredClone(this.s);
    try {
      call(this);
    } finally {
      this.s = backup;
      this.events = [];
    }
  }

  ////////////////////////////////////////////
  //// Storage helpers (mapping reads default to zero, like Solidity)

  private sentTree(voter: string): string {
    return this.s.sentTreeVote.get(voter) ?? address0;
  }
  private setSentTree(voter: string, value: string) {
    if (value === address0) this.s.sentTreeVote.delete(voter);
    else this.s.sentTreeVote.set(voter, value);
  }
  private recTreeCount(recipient: string): number {
    return this.s.recTreeVoteCount.get(recipient) ?? 0;
  }
  private setRecTreeCount(recipient: string, value: number) {
    this.s.recTreeVoteCount.set(recipient, value);
  }
  private recTree(recipient: string, pos: number): string {
    return this.s.recTreeVote.get(recipient)?.get(pos) ?? address0;
  }
  private setRecTree(recipient: string, pos: number, value: string) {
    let slots = this.s.recTreeVote.get(recipient);
    if (slots === undefined) {
      slots = new Map();
      this.s.recTreeVote.set(recipient, slots);
    }
    if (value === address0) slots.delete(pos);
    else slots.set(pos, value);
  }

  private sentCount(voter: string): number {
    return this.s.sentDagVoteCount.get(voter) ?? 0;
  }
  private setSentCount(voter: string, value: number) {
    this.s.sentDagVoteCount.set(voter, value);
  }
  private recCount(recipient: string): number {
    return this.s.recDagVoteCount.get(recipient) ?? 0;
  }
  private setRecCount(recipient: string, value: number) {
    this.s.recDagVoteCount.set(recipient, value);
  }
  private totalWeight(voter: string): bigint {
    return this.s.sentDagVoteTotalWeight.get(voter) ?? 0n;
  }
  private setTotalWeight(voter: string, value: bigint) {
    this.s.sentDagVoteTotalWeight.set(voter, value);
  }

  // `DagVote memory x = sentDagVote[voter][pos]`: a copy.
  private readSent(voter: string, pos: number): EngineDagVote {
    const v = this.s.sentDagVote.get(voter)?.get(pos);
    return v === undefined ? zeroVote() : { ...v };
  }
  private readRec(recipient: string, pos: number): EngineDagVote {
    const v = this.s.recDagVote.get(recipient)?.get(pos);
    return v === undefined ? zeroVote() : { ...v };
  }
  // `sentDagVote[voter][pos].field = ...`: a reference into storage.
  private sentSlot(voter: string, pos: number): EngineDagVote {
    return this.slot(this.s.sentDagVote, voter, pos);
  }
  private recSlot(recipient: string, pos: number): EngineDagVote {
    return this.slot(this.s.recDagVote, recipient, pos);
  }
  private slot(
    table: Map<string, Map<number, EngineDagVote>>,
    key: string,
    pos: number,
  ): EngineDagVote {
    let slots = table.get(key);
    if (slots === undefined) {
      slots = new Map();
      table.set(key, slots);
    }
    let v = slots.get(pos);
    if (v === undefined) {
      v = zeroVote();
      slots.set(pos, v);
    }
    return v;
  }
  private writeSent(voter: string, pos: number, vote: EngineDagVote) {
    this.slot(this.s.sentDagVote, voter, pos);
    this.s.sentDagVote.get(voter)!.set(pos, { ...vote });
  }
  private writeRec(recipient: string, pos: number, vote: EngineDagVote) {
    this.slot(this.s.recDagVote, recipient, pos);
    this.s.recDagVote.get(recipient)!.set(pos, { ...vote });
  }
  private deleteSent(voter: string, pos: number) {
    this.s.sentDagVote.get(voter)?.delete(pos);
  }
  private deleteRec(recipient: string, pos: number) {
    this.s.recDagVote.get(recipient)?.delete(pos);
  }

  ////////////////////////////////////////////
  //// Personal tree internal

  private removeTreeVote(voter: string) {
    const recipient = this.sentTree(voter);
    const votePos = this.recTree(recipient, 0) === voter ? 0 : 1;

    const last = sub(this.recTreeCount(recipient), 1);
    this.setRecTree(recipient, votePos, this.recTree(recipient, last));
    this.setRecTree(recipient, last, address0);
    this.setRecTreeCount(recipient, last);

    this.setSentTree(voter, address1);
  }

  private addTreeVote(voter: string, recipient: string) {
    check(this.recTreeCount(recipient) < 2, "Ai, aDV 2");
    this.addTreeVoteWithoutCheck(voter, recipient);
  }

  private addTreeVoteWithoutCheck(voter: string, recipient: string) {
    check(this.sentTree(voter) === address1, "Ai, aTVWC 1");

    this.setSentTree(voter, recipient);

    const count = this.recTreeCount(recipient);
    this.setRecTree(recipient, count, voter);
    this.setRecTreeCount(recipient, count + 1);
  }

  private switchTreeVoteWithParent(voter: string) {
    const parent = this.sentTree(voter);
    check(parent !== address0, "Ai, sTVWP 1");
    check(parent !== address1, "Ai, sTVWP 2");

    const gparent = this.sentTree(parent);

    this.removeTreeVote(voter);
    this.removeTreeVote(parent);

    const brother = this.recTree(parent, 0);
    const child1 = this.recTree(voter, 0);
    const child2 = this.recTree(voter, 1);

    this.addTreeVoteWithoutCheck(voter, gparent);
    this.addTreeVoteWithoutCheck(parent, voter);

    if (brother !== address0) {
      this.removeTreeVote(brother);
      this.addTreeVoteWithoutCheck(brother, voter);
    }
    if (child1 !== address0) {
      this.removeTreeVote(child1);
      this.addTreeVoteWithoutCheck(child1, parent);
    }
    if (child2 !== address0) {
      this.removeTreeVote(child2);
      this.addTreeVoteWithoutCheck(child2, parent);
    }
  }

  ////////////////////////////////////////////
  //// Personal tree externals

  joinTree(voter: string, voterName: string, recipient: string) {
    check(this.sentTree(voter) === address0, "A lT 2");
    check(this.sentTree(recipient) !== address0, "A lT 3");
    check(this.recTreeCount(recipient) < 2, "A lT 4");

    this.setSentTree(voter, recipient);
    this.s.nameOf.set(voter, voterName);
    const count = this.recTreeCount(recipient);
    this.setRecTree(recipient, count, voter);
    this.setRecTreeCount(recipient, count + 1);

    this.addDagVote(voter, recipient, 1n);

    this.events.push({ eventName: "JoinTreeEvent", voter, name: voterName, recipient });
  }

  joinTreeAsRoot(voter: string, voterName: string) {
    check(this.sentTree(voter) === address0, "A jTAR 2");
    check(this.root() === address0, "A jTAR 3");

    this.s.nameOf.set(voter, voterName);
    this.setSentTree(voter, address1);
    this.setRecTree(address1, 0, voter);
    this.setRecTreeCount(address1, 1);
  }

  changeName(voter: string, voterName: string) {
    check(this.sentTree(voter) !== address0, "A jTAR 5");
    this.s.nameOf.set(voter, voterName);

    this.events.push({ eventName: "ChangeNameEvent", voter, newName: voterName });
  }

  ////////////////////////////////////////////
  //// Local tree finders

  findNthParent(voter: string, height: number): string {
    if (height === 0) {
      return voter;
    }
    if (this.sentTree(voter) === address1) {
      return address1;
    }
    check(this.sentTree(voter) !== address0, "Ai, fNP 1");

    return this.findNthParent(this.sentTree(voter), height - 1);
  }

  findRelRoot(voter: string): [relRoot: string, relDepth: number] {
    check(this.sentTree(voter) !== address0, "Ai, fRR 1");

    let relRoot = voter;
    let relDepth: number;
    for (relDepth = 0; relDepth < MAX_REL_ROOT_DEPTH; relDepth++) {
      const parent = this.sentTree(relRoot);
      if (parent === address1) {
        break;
      }
      relRoot = parent;
    }
    return [relRoot, relDepth];
  }

  findRelDepthInner(
    voter: string,
    recipient: string,
  ): [isLocal: boolean, sRelRootDiff: number, rRelRootDiff: number] {
    if (this.sentTree(voter) === address0 || this.sentTree(recipient) === address0) {
      return [false, 0, 0];
    }

    const [relRoot, sRelRootDiff] = this.findRelRoot(voter);
    let recipientAncestor = recipient;

    for (let i = 0; i <= sRelRootDiff; i++) {
      if (recipientAncestor === relRoot) {
        return [true, sRelRootDiff, i];
      }
      recipientAncestor = this.sentTree(recipientAncestor);
      if (recipientAncestor === address0) {
        return [false, 0, 0];
      }
    }
    return [false, 0, 0];
  }

  findRelDepth(voter: string, recipient: string): [isLocal: boolean, relDepth: number] {
    const [isLocal, relRootDiff, rDist] = this.findRelDepthInner(voter, recipient);
    return [isLocal, sub(relRootDiff, rDist)];
  }

  findDistAtSameDepth(add1: string, add2: string): [isSameDepth: boolean, distance: number] {
    if (add1 === add2) {
      return [true, 0];
    }
    if (this.sentTree(add1) === address0 || this.sentTree(add2) === address0) {
      return [false, 0];
    }
    if (this.sentTree(add1) === address1 || this.sentTree(add2) === address1) {
      return [false, 0];
    }

    const [isSameDepth, distance] = this.findDistAtSameDepth(
      this.sentTree(add1),
      this.sentTree(add2),
    );
    if (isSameDepth) {
      return [true, distance + 1];
    }
    return [false, 0];
  }

  findDistancesRecNotLower(
    voter: string,
    recipient: string,
  ): [isLocal: boolean, sDist: number, rDist: number] {
    if (this.sentTree(voter) === address0 || this.sentTree(recipient) === address0) {
      return [false, 0, 0];
    }

    const [isLocal, relDepth] = this.findRelDepth(voter, recipient);
    if (!isLocal) {
      return [false, 0, 0];
    }

    const voterAncestor = this.findNthParent(voter, relDepth);
    const [, distance] = this.findDistAtSameDepth(voterAncestor, recipient);

    return [isLocal, distance + relDepth, distance];
  }

  findDistances(
    voter: string,
    recipient: string,
  ): [isLocalEitherWay: boolean, sDist: number, rDist: number] {
    if (this.sentTree(voter) === address0 || this.sentTree(recipient) === address0) {
      return [false, 0, 0];
    }

    let lower: string;
    let higher: string;
    let [isLocal, lowerRelRootDiff, higherRelRootDiff] = this.findRelDepthInner(
      voter,
      recipient,
    );
    if (isLocal) {
      lower = voter;
      higher = recipient;
    } else {
      lower = recipient;
      higher = voter;
      [isLocal, lowerRelRootDiff, higherRelRootDiff] = this.findRelDepthInner(
        recipient,
        voter,
      );
      if (!isLocal) {
        return [false, 0, 0];
      }
    }

    const voterAncestor = this.findNthParent(
      lower,
      sub(lowerRelRootDiff, higherRelRootDiff),
    );
    const [, distance] = this.findDistAtSameDepth(voterAncestor, higher);
    if (lower === voter) {
      return [true, distance + lowerRelRootDiff - higherRelRootDiff, distance];
    }
    return [isLocal, distance, distance + lowerRelRootDiff - higherRelRootDiff];
  }

  ////////////////////////////////////////////
  //// Dag personal externals

  addDagVote(voter: string, recipient: string, weight: bigint) {
    const [votable, voted, sDist, rDist] = this.findSentDagVote(voter, recipient);
    check(votable && !voted, "A aDV 2");
    this.combinedDagAppendSdist(voter, recipient, sDist, rDist, weight);

    this.events.push({ eventName: "AddDagVoteEvent", voter, recipient, weight });
  }

  removeDagVote(voter: string, recipient: string) {
    const [, voted, , , sPos] = this.findSentDagVote(voter, recipient);
    check(voted, "A rDV 2");

    this.safeRemoveSentDagVote(voter, sPos);

    this.events.push({ eventName: "RemoveDagVoteEvent", voter, recipient });
  }

  ////////////////////////////////////////////
  //// Reputation related

  calculateReputation(voter: string): bigint {
    return this.calculateReputationInner(voter, 0);
  }

  private calculateReputationInner(voter: string, depth: number): bigint {
    let voterReputation = 0n;
    if (voter === address0) return 0n;

    for (let count = 0; count < this.recCount(voter); count++) {
      const rDagVote = this.readRec(voter, count);
      voterReputation +=
        (this.calculateReputationInner(rDagVote.id, depth + 1) * rDagVote.weight) /
        this.totalWeight(rDagVote.id);
    }

    voterReputation += 10n ** decimalPoint;
    this.s.reputation.set(voter, voterReputation);
    return voterReputation;
  }

  ////////////////////////////////////////////
  //// DAG finders

  findSentDagVote(
    voter: string,
    recipient: string,
  ): [
    votable: boolean,
    voted: boolean,
    sDist: number,
    rDist: number,
    votePos: number,
    dagVote: EngineDagVote,
  ] {
    const [votable, sDist, rDist] = this.findDistancesRecNotLower(voter, recipient);

    if (!votable || sDist === rDist) {
      return [false, false, 0, 0, 0, zeroVote()];
    }

    for (let i = 0; i < this.sentCount(voter); i++) {
      const sDagVote = this.readSent(voter, i);
      if (sDagVote.id === recipient) {
        return [true, true, sDist, rDist, i, sDagVote];
      }
    }

    return [true, false, sDist, rDist, 0, zeroVote()];
  }

  ////////////////////////////////////////////
  //// Dag internals

  private combinedDagAppendSdist(
    voter: string,
    recipient: string,
    sentDist: number,
    recDist: number,
    weight: bigint,
  ) {
    this.writeSent(voter, this.sentCount(voter), {
      id: recipient,
      weight,
      dist: sentDist,
      posInOther: this.recCount(recipient),
    });
    this.setSentCount(voter, this.sentCount(voter) + 1);
    this.setTotalWeight(voter, this.totalWeight(voter) + weight);
    this.writeRec(recipient, this.recCount(recipient), {
      id: voter,
      weight,
      dist: recDist,
      posInOther: this.sentCount(voter) - 1,
    });
    this.setRecCount(recipient, this.recCount(recipient) + 1);
  }

  // Careful: does not delete the opposite vote.
  private unsafeReplaceSentDagVoteWithLast(voter: string, sPos: number) {
    const sDagVote = this.readSent(voter, sPos);
    this.setTotalWeight(voter, subBig(this.totalWeight(voter), sDagVote.weight));

    const last = sub(this.sentCount(voter), 1);
    if (sPos !== last) {
      const copied = this.readSent(voter, last);
      this.writeSent(voter, sPos, copied);
      this.recSlot(copied.id, copied.posInOther).posInOther = sPos;
    }

    this.deleteSent(voter, last);
    this.setSentCount(voter, last);
  }

  // Careful: does not delete the opposite vote.
  private unsafeReplaceRecDagVoteWithLast(recipient: string, rPos: number) {
    const last = sub(this.recCount(recipient), 1);
    if (rPos !== last) {
      const copied = this.readRec(recipient, last);
      this.writeRec(recipient, rPos, copied);
      this.sentSlot(copied.id, copied.posInOther).posInOther = rPos;
    }

    this.deleteRec(recipient, last);
    this.setRecCount(recipient, last);
  }

  private safeRemoveSentDagVote(voter: string, sPos: number) {
    const sDagVote = this.readSent(voter, sPos);
    this.unsafeReplaceSentDagVoteWithLast(voter, sPos);
    this.unsafeReplaceRecDagVoteWithLast(sDagVote.id, sDagVote.posInOther);
  }

  private safeRemoveRecDagVote(recipient: string, rPos: number) {
    const rDagVote = this.readRec(recipient, rPos);
    this.unsafeReplaceRecDagVoteWithLast(recipient, rPos);
    this.unsafeReplaceSentDagVoteWithLast(rDagVote.id, rDagVote.posInOther);
  }

  private removeAllSentDagVotes(voter: string) {
    for (let i = this.sentCount(voter); 0 < i; --i) {
      this.safeRemoveSentDagVote(voter, i - 1);
    }
  }

  private removeAllRecDagVotes(recipient: string) {
    for (let i = this.recCount(recipient); 0 < i; --i) {
      this.safeRemoveRecDagVote(recipient, i - 1);
    }
  }

  // Move voterWithChangingDagVotes into replacedPositionInTree (or, if that is
  // address0, into a new empty slot under recipient), keeping the dag votes that
  // are still in range and updating their distances.
  private handleDagVoteReplace(
    voterWithChangingDagVotes: string,
    recipient: string,
    replacedPositionInTree: string,
  ) {
    if (replacedPositionInTree === address0) {
      this.setSentTree(tempAddress, address1);
      this.addTreeVote(tempAddress, recipient);
      replacedPositionInTree = tempAddress;
    }

    for (let i = this.sentCount(voterWithChangingDagVotes); 0 < i; --i) {
      const sDagVote = this.readSent(voterWithChangingDagVotes, i - 1);
      const [isLocal, sDist, rDist] = this.findDistancesRecNotLower(
        replacedPositionInTree,
        sDagVote.id,
      );
      if (!isLocal || sDist === rDist) {
        this.safeRemoveSentDagVote(voterWithChangingDagVotes, i - 1);
        continue;
      }
      this.sentSlot(voterWithChangingDagVotes, i - 1).dist = sDist;
      this.recSlot(sDagVote.id, sDagVote.posInOther).dist = rDist;
    }

    for (let i = this.recCount(voterWithChangingDagVotes); 0 < i; --i) {
      const rDagVote = this.readRec(voterWithChangingDagVotes, i - 1);
      const [isLocal, sDist, rDist] = this.findDistancesRecNotLower(
        rDagVote.id,
        replacedPositionInTree,
      );
      if (!isLocal || sDist === rDist) {
        this.safeRemoveRecDagVote(voterWithChangingDagVotes, i - 1);
        continue;
      }
      this.recSlot(voterWithChangingDagVotes, i - 1).dist = rDist;
      this.sentSlot(rDagVote.id, rDagVote.posInOther).dist = sDist;
    }

    if (replacedPositionInTree === tempAddress) {
      this.removeTreeVote(tempAddress);
    }
  }

  ////////////////////////////////////////////
  //// Global internal

  // Recursively pull up the branch of the first child.
  private pullUpBranch(pulledVoter: string, parent: string) {
    const firstChild = this.recTree(pulledVoter, 0);
    const secondChild = this.recTree(pulledVoter, 1);
    if (firstChild !== address0) {
      this.handleDagVoteReplace(firstChild, parent, pulledVoter);
      const [, voted, , , votePos, dagVote] = this.findSentDagVote(firstChild, parent);
      if (voted) {
        // both rise later, so the distance was changed incorrectly.
        this.sentSlot(firstChild, votePos).dist = dagVote.dist + 1;
      }

      this.pullUpBranch(firstChild, pulledVoter);

      if (secondChild !== address0) {
        this.removeTreeVote(secondChild);
        this.addTreeVote(secondChild, firstChild);
      }
    }
  }

  private handleLeavingVoterBranch(voter: string) {
    const parent = this.sentTree(voter);

    const firstChild = this.recTree(voter, 0);
    const secondChild = this.recTree(voter, 1);

    if (firstChild !== address0) {
      this.handleDagVoteReplace(firstChild, parent, voter);

      this.pullUpBranch(firstChild, voter);

      if (secondChild !== address0) {
        this.removeTreeVote(secondChild);
        this.addTreeVote(secondChild, firstChild);
      }

      this.removeTreeVote(firstChild);
      this.addTreeVoteWithoutCheck(firstChild, parent);
    }

    this.removeTreeVote(voter);
    this.setSentTree(voter, address1);
  }

  ////////////////////////////////////////////
  //// Global external

  leaveTree(voter: string) {
    this.removeAllSentDagVotes(voter);
    this.removeAllRecDagVotes(voter);

    this.handleLeavingVoterBranch(voter);
    this.setSentTree(voter, address0);

    this.events.push({ eventName: "LeaveTreeEvent", voter });
  }

  switchPositionWithParent(voter: string) {
    const parent = this.sentTree(voter);
    check(parent !== address0, "A lT 3");
    check(parent !== address1, "A lT 4");
    const gparent = this.sentTree(parent);

    const voterRep = this.calculateReputation(voter);
    const parentRep = this.calculateReputation(parent);

    check(voterRep > parentRep, "A lT 5");

    this.handleDagVoteReplace(parent, parent, voter);
    this.handleDagVoteReplace(voter, gparent, parent);

    this.switchTreeVoteWithParent(voter);

    this.events.push({ eventName: "SwitchPositionWithParentEvent", voter });
  }

  moveTreeVote(voter: string, recipient: string) {
    check(this.sentTree(voter) !== address0, "A mTV 2");
    check(this.sentTree(recipient) !== address0, "A mTV 3");
    check(this.recTreeCount(recipient) < 2, "A mTV 4");
    // moving under yourself would detach you into a loop.
    check(voter !== recipient, "A mTV 5");

    let [isLocal, sDist, rDist] = this.findDistances(voter, recipient);

    // leave the tree now, so that our descendants can rise.
    const parent = this.sentTree(voter);
    this.handleLeavingVoterBranch(voter);

    if (sDist === 0 && isLocal) {
      // jumping to our descendant who just rose: fix up rDist.
      if (this.findNthParent(recipient, rDist) === parent) {
        rDist = sub(rDist, 1);
      }
    }

    if (isLocal) {
      this.handleDagVoteReplace(voter, recipient, address0);
    } else {
      // completely jumped out: remove all dag votes.
      this.removeAllSentDagVotes(voter);
      this.removeAllRecDagVotes(voter);
    }

    this.addTreeVote(voter, recipient);

    this.events.push({ eventName: "MoveTreeVoteEvent", voter, recipient });
  }

  root(): string {
    return this.recTree(address1, 0);
  }

  isInTree(voter: string): boolean {
    return this.sentTree(voter) !== address0;
  }

  // Not in the contract: everyone currently in the tree.
  members(): string[] {
    const ids: string[] = [];
    for (const [id, parent] of this.s.sentTreeVote) {
      if (parent !== address0 && id !== tempAddress && id !== address1) ids.push(id);
    }
    return ids;
  }

  // Not in the contract: the voter's parent (address1 for the root).
  parent(voter: string): string {
    return this.sentTree(voter);
  }

  // Not in the contract: everyone the voter endorses.
  endorsing(voter: string): string[] {
    return Array.from({ length: this.sentCount(voter) }, (_, i) => this.readSent(voter, i).id);
  }

  // Not in the contract: the voter's children in tree order.
  children(voter: string): string[] {
    const count = this.recTreeCount(voter);
    return Array.from({ length: count }, (_, i) => this.recTree(voter, i));
  }

  // Not in the contract: whether `voter` already votes for `recipient`, and
  // whether they could (votable = recipient is local and higher).
  dagVoteState(voter: string, recipient: string) {
    const [votable, voted] = this.findSentDagVote(voter, recipient);
    return { votable, voted };
  }

  ////////////////////////////////////////////
  //// Getters, shaped like the viem contract reads that dagLoading uses.

  read = {
    MAX_REL_ROOT_DEPTH: async () => BigInt(MAX_REL_ROOT_DEPTH),
    root: async () => this.root(),
    nameOf: async ([voter]: readonly [string]) => this.s.nameOf.get(voter) ?? "",
    sentTreeVote: async ([voter]: readonly [string]) => this.sentTree(voter),
    recTreeVoteCount: async ([recipient]: readonly [string]) =>
      BigInt(this.recTreeCount(recipient)),
    recTreeVote: async ([recipient, pos]: readonly [string, bigint]) =>
      this.recTree(recipient, Number(pos)),
    sentDagVoteCount: async ([voter]: readonly [string]) => BigInt(this.sentCount(voter)),
    recDagVoteCount: async ([recipient]: readonly [string]) =>
      BigInt(this.recCount(recipient)),
    sentDagVote: async ([voter, pos]: readonly [string, bigint]) =>
      voteTuple(this.readSent(voter, Number(pos))),
    recDagVote: async ([recipient, pos]: readonly [string, bigint]) =>
      voteTuple(this.readRec(recipient, Number(pos))),
    sentDagVoteTotalWeight: async ([voter]: readonly [string]) => this.totalWeight(voter),
    calculatedReputationForEpoch: async ([voter]: readonly [string]) =>
      this.s.calculatedReputationForEpoch.get(voter) ?? 0n,
    reputation: async ([voter]: readonly [string]) => this.s.reputation.get(voter) ?? 0n,
  };

  ////////////////////////////////////////////
  //// Seeding

  // Load the state of a crawled graph (anthillSnapshot.json). Throws if the
  // graph's vote links are inconsistent.
  loadFromGraph(graph: SeedGraph) {
    this.s = emptyState();
    const id = (x: string) => x.toLowerCase();

    for (const node of Object.values(graph.dict)) {
      const nodeId = id(node.id);
      node.recTreeVotes.forEach((child, pos) => this.setRecTree(nodeId, pos, id(child)));
      this.setRecTreeCount(nodeId, node.recTreeVotes.length);
      if (nodeId === address1) {
        continue;
      }
      this.s.nameOf.set(nodeId, node.name);
      this.setSentTree(nodeId, id(node.sentTreeVote));
      node.sentDagVotes.forEach((v, pos) =>
        this.writeSent(nodeId, pos, { ...v, id: id(v.id) }),
      );
      this.setSentCount(nodeId, node.sentDagVotes.length);
      this.setTotalWeight(nodeId, node.totalWeight);
      // dist is fixed below: the graph holds the sender's dist here.
      node.recDagVotes.forEach((v, pos) =>
        this.writeRec(nodeId, pos, { ...v, id: id(v.id) }),
      );
      this.setRecCount(nodeId, node.recDagVotes.length);
    }

    for (const [recipient, slots] of this.s.recDagVote) {
      for (const [pos, rVote] of slots) {
        const sVote = this.readSent(rVote.id, rVote.posInOther);
        if (sVote.id !== recipient || sVote.posInOther !== pos) {
          throw new Error(`seed: vote ${rVote.id} -> ${recipient} is not linked both ways`);
        }
        const [isLocal, sDist, rDist] = this.findDistancesRecNotLower(rVote.id, recipient);
        if (!isLocal || sDist !== sVote.dist) {
          throw new Error(`seed: vote ${rVote.id} -> ${recipient} has a stale dist`);
        }
        this.recSlot(recipient, pos).dist = rDist;
      }
    }
  }
}

function voteTuple(v: EngineDagVote) {
  return [v.id, v.weight, BigInt(v.dist), BigInt(v.posInOther)] as const;
}
