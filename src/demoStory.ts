// The demo community's story. The original tree only ever grew: people joined
// and endorsed. This adds the other things people do, so the replay shows
// them:
//   1. in each half of the tree, a rising member's supporters back them
//      instead of their parent, until they climb above the parent;
//   2. a few people change who they endorse;
//   3. someone leaves, and their branch moves up;
//   4. two people move up into a free spot in the other half of the tree
//      (where the branch moved up), and endorse their new parent;
//   5. newcomers join under the first climber and endorse them.
// Every action is run as that member through the same checks as a real one
// (an action that isn't possible is skipped) and logged like any other; the
// server plays it once on startup, before loading, so the load replays it
// like everything else. Real people never act in it.

import type { AnthillEngine } from "./engine";
import { ActionError, type OffchainTree } from "./offchain";

const address1 = "0x0000000000000000000000000000000000000001";

const NEWCOMERS = [
  { id: "0x00000000000000000000000000000000000000a1", name: "Zoe" },
  { id: "0x00000000000000000000000000000000000000a2", name: "Uri" },
];

// endorsements switched before a climb, at most
const MAX_SWITCHES = 8;

type Body = { fn: string; args?: Record<string, string> };

// Plays the story in `tree` (loaded, and thrown away afterwards: the actions
// are in the log). Returns how many actions it took.
export function playDemoStory(
  tree: OffchainTree,
  invite: (under: string) => string,
  isReal: (id: string) => boolean,
): number {
  const e = tree.engine;
  let count = 0;
  const act = (by: string, body: Body) => {
    try {
      tree.execute(by, body);
    } catch (err) {
      if (err instanceof ActionError) return false;
      throw err;
    }
    count++;
    return true;
  };

  const depth = (id: string) => {
    let d = 0;
    for (let p = e.parent(id); p !== address1 && d < 64; p = e.parent(p)) d++;
    return d;
  };
  const below = (engine: AnthillEngine, id: string): string[] => {
    const out: string[] = [];
    const queue = [...engine.children(id)];
    while (queue.length > 0) {
      const next = queue.shift()!;
      out.push(next);
      queue.push(...engine.children(next));
    }
    return out;
  };
  const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const actors = () => e.members().filter((id) => !isReal(id)).sort(byId);
  // the branch just under the root that someone is in
  const branch = (id: string) => {
    let at = id;
    while (e.parent(at) !== address1 && e.parent(e.parent(at)) !== address1) at = e.parent(at);
    return at;
  };
  const used = new Set<string>();

  // 1. Switching support until the star can climb. `step` runs one action on
  // `engine` and says whether it worked; the same plan runs as a rehearsal
  // (on a throwaway copy) and for real.
  const plan = (
    engine: AnthillEngine,
    star: string,
    step: (by: string, body: Body) => boolean,
  ): number | undefined => {
    const climb = { fn: "switchPositionWithParent" };
    if (step(star, climb)) return 0;
    const parent = engine.parent(star);
    let switched = 0;
    for (const fan of below(engine, star).filter((id) => !isReal(id))) {
      if (switched >= MAX_SWITCHES) break;
      // someone under the star backs them instead of their parent: drop the
      // parent (their support is split between fewer people, the star among
      // them) and endorse the star if they don't yet
      const backsStar = engine.endorsing(fan).includes(star);
      const backsParent = engine.endorsing(fan).includes(parent);
      if (backsStar ? !backsParent : !engine.dagVoteState(fan, star).votable) continue;
      if (backsParent && !step(fan, { fn: "removeDagVote", args: { recipient: parent } })) continue;
      if (!backsStar) step(fan, { fn: "addDagVote", args: { recipient: star, weight: "1" } });
      switched++;
      if (step(star, climb)) return switched;
    }
    return undefined;
  };
  // how many switched endorsements it takes, on a copy that's thrown away
  const rehearse = (star: string) => {
    let cost: number | undefined;
    e.simulate((sim) => {
      cost = plan(sim, star, (by, body) => {
        try {
          sim.run((s) => apply(s, by, body));
          return true;
        } catch {
          return false;
        }
      });
    });
    return cost;
  };

  const stars: string[] = [];
  for (let i = 0; i < 2; i++) {
    const candidates: { star: string; cost: number }[] = [];
    for (const id of actors()) {
      if (depth(id) < 2 || depth(id) > 4 || used.has(id) || used.has(e.parent(id))) continue;
      if (stars.some((s) => branch(s) === branch(id))) continue;
      const cost = rehearse(id);
      if (cost !== undefined) candidates.push({ star: id, cost });
    }
    // a visible build-up (two switches or more), then the most people below
    candidates.sort(
      (a, b) =>
        Number(a.cost < 2) - Number(b.cost < 2) ||
        a.cost - b.cost ||
        below(e, b.star).length - below(e, a.star).length ||
        byId(a.star, b.star),
    );
    const star = candidates[0]?.star;
    if (star === undefined) break;
    used.add(star);
    used.add(e.parent(star));
    for (const id of below(e, star)) used.add(id);
    plan(e, star, act);
    stars.push(star);
  }
  const star = stars[0];

  // 2. People changing who they endorse: from someone they endorse to the
  // highest person they can reach.
  let changes = 0;
  for (const id of actors()) {
    if (changes >= 3) break;
    if (used.has(id)) continue;
    const from = e.endorsing(id).find((to) => !isReal(to));
    const to = tree.reach(id).sort((a, b) => depth(a) - depth(b) || byId(a, b))[0];
    if (from === undefined || to === undefined) continue;
    if (!act(id, { fn: "removeDagVote", args: { recipient: from } })) continue;
    act(id, { fn: "addDagVote", args: { recipient: to, weight: "1" } });
    used.add(id);
    changes++;
  }

  // 3. Leaving: someone in the middle of the tree leaves, and the people under
  // them move up (which frees a spot higher up).
  const leaver = actors()
    .filter((id) => !used.has(id) && e.children(id).length === 2 && depth(id) >= 2)
    .sort((a, b) => depth(a) - depth(b) || byId(a, b))[0];
  if (leaver !== undefined) act(leaver, { fn: "leaveTree" });

  // 4. Moving: someone at the bottom moves up to a free spot in the other half
  // of the tree, then endorses their new parent.
  let moves = 0;
  const leaves = actors()
    .filter((id) => e.children(id).length === 0 && !used.has(id))
    .sort((a, b) => depth(b) - depth(a) || byId(a, b));
  for (const leaf of leaves) {
    if (moves >= 2) break;
    const target = actors()
      .filter(
        (id) =>
          id !== leaf &&
          e.children(id).length < 2 &&
          branch(id) !== branch(leaf) &&
          depth(id) < depth(leaf),
      )
      .sort((a, b) => depth(a) - depth(b) || byId(a, b))
      .find((id) => tree.check(leaf, [{ fn: "moveTreeVote", args: { recipient: id } }])[0].ok);
    if (target === undefined) continue;
    act(leaf, { fn: "moveTreeVote", args: { recipient: target } });
    act(leaf, { fn: "addDagVote", args: { recipient: target, weight: "1" } });
    used.add(leaf);
    moves++;
  }

  // 5. Newcomers join under the first climber (at the first free spot there that
  // isn't a real person's) and endorse them.
  if (star !== undefined && e.isInTree(star)) {
    for (const { id, name } of NEWCOMERS) {
      if (e.isInTree(id)) continue;
      const spot = [star, ...below(e, star)].find((at) => !isReal(at) && e.children(at).length < 2);
      if (spot === undefined) break;
      if (act(id, { fn: "joinTree", args: { name, invite: invite(spot) } })) {
        act(id, { fn: "addDagVote", args: { recipient: star, weight: "1" } });
      }
    }
  }

  return count;
}

// The engine call for an action (for the rehearsal, which bypasses the log).
function apply(engine: AnthillEngine, voter: string, body: Body) {
  const recipient = body.args?.recipient ?? "";
  switch (body.fn) {
    case "addDagVote":
      return engine.addDagVote(voter, recipient, BigInt(body.args?.weight ?? "1"));
    case "removeDagVote":
      return engine.removeDagVote(voter, recipient);
    case "switchPositionWithParent":
      return engine.switchPositionWithParent(voter);
    default:
      throw new Error(`not rehearsed: ${body.fn}`);
  }
}
