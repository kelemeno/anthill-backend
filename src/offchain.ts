// Off-chain mode: the engine (a port of the contract) holds the tree, the
// append-only store makes it durable, and signed-in passkey users act as
// voters. This replaces the chain + wallet: the server checks who is acting and
// the engine enforces the same rules the contract did.

import { AnthillEngine, type EngineEvent, Revert } from "./engine";
import type { Action, ActionEntry, Store } from "./store";

const MAX_NAME_LENGTH = 40;
const MAX_WEIGHT = 100n;

export class ActionError extends Error {}

export class OffchainTree {
  readonly engine = new AnthillEngine();

  constructor(private store: Store) {}

  // Rebuild the engine from the log. Calls onReplayed after each replayed action
  // (used to rebuild history).
  async load(onReplayed: (entry: ActionEntry, events: EngineEvent[]) => Promise<void>) {
    const seed = this.store.seed;
    if (seed !== undefined) {
      this.engine.loadFromGraph(seed);
    }
    for (const entry of this.store.actions) {
      try {
        const events = this.engine.run((e) => apply(e, entry.by, entry.action));
        await onReplayed(entry, events);
      } catch (e) {
        // Only happens if the engine's rules changed since the action was taken.
        console.warn("replay: skipping action that now fails", entry, e);
      }
    }
  }

  // Validate, run and persist one action by a signed-in user.
  execute(by: string, body: unknown): { entry: ActionEntry; events: EngineEvent[] } {
    const action = parseAction(body);
    let events: EngineEvent[];
    try {
      events = this.engine.run((e) => apply(e, by, action));
    } catch (e) {
      if (e instanceof Revert) {
        throw new ActionError(e.message);
      }
      throw e;
    }
    return { entry: this.store.appendAction(by, action), events };
  }
}

function apply(engine: AnthillEngine, voter: string, action: Action) {
  switch (action.fn) {
    case "joinTree":
      return engine.joinTree(voter, action.args.name, action.args.recipient);
    case "joinTreeAsRoot":
      return engine.joinTreeAsRoot(voter, action.args.name);
    case "changeName":
      return engine.changeName(voter, action.args.name);
    case "addDagVote":
      return engine.addDagVote(voter, action.args.recipient, BigInt(action.args.weight));
    case "removeDagVote":
      return engine.removeDagVote(voter, action.args.recipient);
    case "leaveTree":
      return engine.leaveTree(voter);
    case "switchPositionWithParent":
      return engine.switchPositionWithParent(voter);
    case "moveTreeVote":
      return engine.moveTreeVote(voter, action.args.recipient);
  }
}

// Turn an untrusted request body into an Action, normalising ids to lowercase.
function parseAction(body: unknown): Action {
  if (typeof body !== "object" || body === null) {
    throw new ActionError("expected a JSON body");
  }
  const { fn, args = {} } = body as { fn?: unknown; args?: Record<string, unknown> };

  const id = (key: string) => {
    const v = args[key];
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
      throw new ActionError(`${key} must be a 20-byte hex id`);
    }
    return v.toLowerCase();
  };
  const name = () => {
    const v = args.name;
    if (typeof v !== "string" || v.trim() === "" || v.trim().length > MAX_NAME_LENGTH) {
      throw new ActionError(`name must be 1-${MAX_NAME_LENGTH} characters`);
    }
    return v.trim();
  };

  switch (fn) {
    case "joinTree":
      return { fn, args: { name: name(), recipient: id("recipient") } };
    case "joinTreeAsRoot":
    case "changeName":
      return { fn, args: { name: name() } };
    case "addDagVote": {
      let weight: bigint;
      try {
        weight = BigInt(String(args.weight ?? "1"));
      } catch {
        throw new ActionError("weight must be a whole number");
      }
      if (weight < 1n || weight > MAX_WEIGHT) {
        throw new ActionError(`weight must be 1-${MAX_WEIGHT}`);
      }
      return { fn, args: { recipient: id("recipient"), weight: weight.toString() } };
    }
    case "removeDagVote":
    case "moveTreeVote":
      return { fn, args: { recipient: id("recipient") } };
    case "leaveTree":
    case "switchPositionWithParent":
      return { fn, args: {} };
    default:
      throw new ActionError(`unknown action ${String(fn)}`);
  }
}
