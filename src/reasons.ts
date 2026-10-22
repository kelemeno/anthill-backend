// Human-readable reasons for the engine's revert codes (the contract's
// `require` messages), so the UI can say why an action isn't possible.

const reasons: Record<string, string> = {
  // joinTree
  "A lT 2": "You're already in the tree.",
  // joinTree / switchPositionWithParent share codes with different meanings,
  // see explain().
  "A jTAR 2": "You're already in the tree.",
  "A jTAR 3": "The tree already has a root.",
  "A jTAR 5": "Join the tree first.",
  // votes
  "A rDV 2": "You don't have a reputation vote for them.",
  // moveTreeVote
  "A mTV 2": "Join the tree first.",
  "A mTV 3": "That person isn't in the tree.",
  "A mTV 4": "That spot is full: two people are already under them.",
  "A mTV 5": "You can't move under yourself.",
  // internal checks that can surface through moves
  "Ai, aDV 2": "That spot is full: two people are already under them.",
};

export function explain(
  fn: string,
  code: string,
  context: { voterInTree: boolean; voted?: boolean },
): string {
  if (!context.voterInTree && fn !== "joinTree" && fn !== "joinTreeAsRoot") {
    return "Join the tree first.";
  }
  if (fn === "joinTree") {
    if (code === "A lT 3") return "That person isn't in the tree.";
    if (code === "A lT 4") return "That spot is full: two people are already under them.";
  }
  if (fn === "switchPositionWithParent") {
    if (code === "A lT 3") return "Join the tree first.";
    if (code === "A lT 4") return "You're at the top: there's no one above you.";
    if (code === "A lT 5") {
      return "Your reputation needs to be higher than your parent's to switch with them.";
    }
  }
  if (fn === "addDagVote" && code === "A aDV 2") {
    return context.voted
      ? "You already give them a reputation vote."
      : "You can only vote for people above you in your part of the tree (up to 6 levels up), not at your own level.";
  }
  if (code.startsWith("panic")) return "That isn't possible right now.";
  return reasons[code] ?? code;
}
