// Off-chain mode: the engine (a port of the contract) holds the tree, the
// append-only store makes it durable, and signed-in passkey users act as
// voters. This replaces the chain + wallet: the server checks who is acting and
// the engine enforces the same rules the contract did.
//
// Joining: with an invite code, the newcomer is placed under the inviter (or
// the nearest free spot below them). INVITE_ONLY=true makes an invite
// required; otherwise anyone can still join under any node with a free spot.

import { randomBytes } from "node:crypto";
import { AnthillEngine, type EngineEvent, Revert } from "./engine";
import { explain } from "./reasons";
import type { Action, ActionEntry, Invite, Store } from "./store";

const MAX_NAME_LENGTH = 40;
const MAX_WEIGHT = 100n;
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_OPEN_INVITES = 10;

export const inviteOnly = process.env.INVITE_ONLY === "true";

export class ActionError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export type CheckResult = { ok: true } | { ok: false; reason: string; code?: string };

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
    const action = this.prepare(by, parseAction(body));
    let events: EngineEvent[];
    try {
      events = this.engine.run((e) => apply(e, by, action));
    } catch (e) {
      throw this.toActionError(by, action, e);
    }
    return { entry: this.store.appendAction(by, action), events };
  }

  // Dry-run actions without changing anything: whether each would succeed, and
  // if not, why (in words).
  check(by: string, bodies: unknown[]): CheckResult[] {
    return bodies.map((body) => {
      let action: Action | undefined;
      try {
        action = this.prepare(by, parseAction(body));
        const prepared = action;
        this.engine.simulate((e) => apply(e, by, prepared));
        return { ok: true };
      } catch (e) {
        const error = action === undefined ? e : this.toActionError(by, action, e);
        if (error instanceof ActionError) {
          return { ok: false, reason: error.message, code: error.code };
        }
        throw error;
      }
    });
  }

  ////////////////////////////////////////////
  //// invites

  createInvite(by: string): Invite {
    if (!this.engine.isInTree(by)) {
      throw new ActionError("Join the tree first, then you can invite people.");
    }
    if (this.store.openInvitesBy(by).length >= MAX_OPEN_INVITES) {
      throw new ActionError(
        `You already have ${MAX_OPEN_INVITES} unused invites. Wait until some are used or expire.`,
      );
    }
    return this.storeInvite(by, by);
  }

  // Admin invite (for bootstrapping an invite-only tree): joins under `under`.
  createAdminInvite(under: string): Invite {
    if (!this.engine.isInTree(under)) {
      throw new ActionError("That node isn't in the tree.");
    }
    return this.storeInvite("admin", under);
  }

  private storeInvite(by: string, under: string): Invite {
    const invite: Invite = {
      code: randomBytes(12).toString("base64url"),
      by,
      under,
      expires: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    };
    this.store.addInvite(invite);
    return invite;
  }

  // Throws an ActionError explaining why the invite can't be used.
  validInvite(code: string): Invite {
    const invite = this.store.invite(code);
    if (invite === undefined) {
      throw new ActionError("This invite link isn't valid.");
    }
    if (invite.usedBy !== undefined) {
      throw new ActionError("This invite has already been used.");
    }
    if (invite.expires < new Date().toISOString()) {
      throw new ActionError("This invite has expired. Ask for a new one.");
    }
    if (!this.engine.isInTree(invite.under)) {
      throw new ActionError("The person who invited you is no longer in the tree.");
    }
    return invite;
  }

  // The first node at or below `under` (breadth first) with a free spot.
  private placeUnder(under: string): string {
    const queue = [under];
    while (queue.length > 0) {
      const node = queue.shift()!;
      const children = this.engine.children(node);
      if (children.length < 2) return node;
      queue.push(...children);
    }
    throw new ActionError("There's no free spot under the person who invited you.");
  }

  ////////////////////////////////////////////

  // Resolve invite placement and enforce INVITE_ONLY before the engine runs.
  private prepare(by: string, action: Action): Action {
    if (action.fn !== "joinTree") return action;
    const { invite } = action.args;
    if (invite === undefined) {
      if (inviteOnly) {
        throw new ActionError("Joining needs an invite from someone in the tree.");
      }
      return action;
    }
    if (this.engine.isInTree(by)) {
      throw new ActionError("You're already in the tree.", "A lT 2");
    }
    const { under } = this.validInvite(invite);
    return { fn: "joinTree", args: { ...action.args, recipient: this.placeUnder(under) } };
  }

  private toActionError(by: string, action: Action, e: unknown): unknown {
    if (e instanceof ActionError) return e;
    if (e instanceof Revert) {
      const recipient = (action.args as { recipient?: string }).recipient;
      const voted =
        action.fn === "addDagVote" && recipient !== undefined
          ? this.engine.dagVoteState(by, recipient).voted
          : undefined;
      return new ActionError(
        explain(action.fn, e.message, { voterInTree: this.engine.isInTree(by), voted }),
        e.message,
      );
    }
    if (e instanceof RangeError) {
      // stack overflow or division by zero inside the engine (a panic on chain)
      return new ActionError("That isn't possible right now.", "panic");
    }
    return e;
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
      throw new ActionError(`Names must be 1-${MAX_NAME_LENGTH} characters.`);
    }
    return v.trim();
  };

  switch (fn) {
    case "joinTree": {
      if (typeof args.invite === "string") {
        // the recipient comes from the invite (see prepare)
        return { fn, args: { name: name(), recipient: "", invite: args.invite } };
      }
      return { fn, args: { name: name(), recipient: id("recipient") } };
    }
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
