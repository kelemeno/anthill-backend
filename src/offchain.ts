// Off-chain mode: an engine (a port of the contract) holds each community's
// tree, the append-only store makes it durable, and signed-in passkey users act
// as voters. This replaces the chain + wallet: the server checks who is acting
// and the engine enforces the same rules the contract did.
//
// Communities are independent trees sharing one set of accounts. Anyone signed
// in can start one and becomes its root. Public communities can be seen by
// everyone; private ones only by their members.
//
// Joining: with an invite code, the newcomer is placed under the inviter (or
// the nearest free spot below them). In a community whose join policy is
// "invite" (always the case for private ones) an invite is required; otherwise
// anyone can join under any node with a free spot.

import { randomBytes } from "node:crypto";
import { AnthillEngine, type EngineEvent, Revert } from "./engine";
import { explain } from "./reasons";
import {
  type Action,
  type ActionEntry,
  type CommunityInfo,
  type CommunitySettings,
  communityOf,
  DEFAULT_COMMUNITY,
  type Invite,
  type Store,
  type StoredUser,
} from "./store";

export const MAX_NAME_LENGTH = 40;
const MAX_WEIGHT = 100n;
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_OPEN_INVITES = 10;
const MAX_COMMUNITY_NAME = 60;
const MAX_DESCRIPTION = 280;
const MAX_COMMUNITIES_PER_FOUNDER = 10;
// Lowercase letters, digits and dashes, 3-32 long; used in URLs (/c/<id>).
const COMMUNITY_ID = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const RESERVED_IDS = new Set(["admin", "api", "c", "new", "p", "invite", "settings", "www"]);

export class ActionError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export type CheckResult = { ok: true } | { ok: false; reason: string; code?: string };

export type Executed = { tree: OffchainTree; entry: ActionEntry; events: EngineEvent[] };

// One community's tree.
export class OffchainTree {
  readonly engine = new AnthillEngine();

  constructor(
    private store: Store,
    readonly id: string,
  ) {}

  get info(): CommunityInfo {
    return this.store.community(this.id)!;
  }

  // Whether `viewer` (a user id, or undefined when signed out) may see this
  // community: anyone for public ones, members and the founder for private.
  visibleTo(viewer: string | undefined): boolean {
    const { visibility, createdBy } = this.info;
    if (visibility === "public") return true;
    return viewer !== undefined && (viewer === createdBy || this.engine.isInTree(viewer));
  }

  // Validate, run and persist one action by a signed-in user.
  execute(by: string, body: unknown): Executed {
    const action = this.prepare(by, parseAction(body));
    let events: EngineEvent[];
    try {
      events = this.engine.run((e) => apply(e, by, action));
    } catch (e) {
      throw this.toActionError(by, action, e);
    }
    return { tree: this, entry: this.store.appendAction(this.id, by, action), events };
  }

  // Run an action from the log again (on startup).
  replay(entry: ActionEntry): EngineEvent[] {
    return this.engine.run((e) => apply(e, entry.by, entry.action));
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

  // Everyone `voter` could endorse right now but doesn't yet.
  reach(voter: string): string[] {
    if (!this.engine.isInTree(voter)) return [];
    return this.engine.members().filter((m) => {
      if (m === voter) return false;
      const { votable, voted } = this.engine.dagVoteState(voter, m);
      return votable && !voted;
    });
  }

  ////////////////////////////////////////////
  //// invites

  createInvite(by: string): Invite {
    if (!this.engine.isInTree(by)) {
      throw new ActionError("Join the tree first, then you can invite people.");
    }
    if (this.store.openInvitesBy(this.id, by).length >= MAX_OPEN_INVITES) {
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
    if (this.id !== DEFAULT_COMMUNITY) invite.community = this.id;
    this.store.addInvite(invite);
    return invite;
  }

  // Throws an ActionError explaining why the invite can't be used.
  validInvite(code: string): Invite {
    const invite = this.store.invite(code);
    if (invite === undefined || communityOf(invite) !== this.id) {
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

  // Resolve invite placement and enforce the join policy before the engine
  // runs.
  private prepare(by: string, action: Action): Action {
    const { joinPolicy, createdBy } = this.info;
    if (action.fn === "joinTreeAsRoot") {
      // Only possible in an empty tree (the engine checks that). Restarting an
      // invite-only community that everyone left is up to its founder.
      if (joinPolicy === "invite" && by !== createdBy) {
        throw new ActionError("Only the founder can restart this community.");
      }
      return action;
    }
    if (action.fn !== "joinTree") return action;
    const { invite } = action.args;
    if (invite === undefined) {
      if (joinPolicy === "invite") {
        throw new ActionError("Joining needs an invite from someone in the community.");
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

// All communities' trees, rebuilt from the log on startup.
export class Communities {
  private trees = new Map<string, OffchainTree>();

  constructor(private store: Store) {
    for (const { id } of store.communities()) {
      this.trees.set(id, new OffchainTree(store, id));
    }
  }

  get(id: string): OffchainTree | undefined {
    return this.trees.get(id);
  }

  all(): OffchainTree[] {
    return [...this.trees.values()];
  }

  // Rebuild the engines from the log. Calls onReplayed after each replayed
  // action (used to rebuild history).
  async load(onReplayed: (executed: Executed) => Promise<void>) {
    const seed = this.store.seed;
    if (seed !== undefined) {
      this.trees.get(DEFAULT_COMMUNITY)!.engine.loadFromGraph(seed);
    }
    for (const entry of this.store.actions) {
      const tree = this.trees.get(communityOf(entry));
      let events: EngineEvent[];
      try {
        if (tree === undefined) throw new Error("no such community");
        events = tree.replay(entry);
      } catch (e) {
        // Only happens if the engine's rules changed since the action was taken.
        console.warn("replay: skipping action that now fails", entry, e);
        continue;
      }
      await onReplayed({ tree, entry, events });
    }
  }

  // Start a community; its founder becomes the root of its tree.
  create(founder: StoredUser, body: unknown): Executed {
    const { id: rawId, ...rest } = (body ?? {}) as { id?: unknown };
    const id = typeof rawId === "string" ? rawId.trim().toLowerCase() : "";
    if (!COMMUNITY_ID.test(id) || RESERVED_IDS.has(id)) {
      throw new ActionError(
        "The address must be 3-32 lowercase letters, digits or dashes, starting and ending with a letter or digit.",
      );
    }
    if (this.trees.has(id)) {
      throw new ActionError("That address is taken. Try another one.");
    }
    const founded = this.store.communities().filter((c) => c.createdBy === founder.id);
    if (founded.length >= MAX_COMMUNITIES_PER_FOUNDER) {
      throw new ActionError(`You can start at most ${MAX_COMMUNITIES_PER_FOUNDER} communities.`);
    }
    const settings = parseSettings(rest);
    this.store.addCommunity({
      id,
      ...settings,
      createdBy: founder.id,
      createdAt: new Date().toISOString(),
    });
    const tree = new OffchainTree(this.store, id);
    this.trees.set(id, tree);
    return tree.execute(founder.id, { fn: "joinTreeAsRoot", args: { name: founder.name } });
  }

  // Change a community's name, description, visibility or join policy.
  updateSettings(by: string, tree: OffchainTree, body: unknown): CommunityInfo {
    if (by !== tree.info.createdBy) {
      throw new ActionError("Only the founder can change the community's settings.");
    }
    this.store.updateCommunity(tree.id, parseSettings(body));
    return tree.info;
  }

  // Rename an account, and its node in every tree it's in.
  rename(user: StoredUser, body: unknown): Executed[] {
    const name = parseName((body as { name?: unknown } | null)?.name);
    this.store.setUserName(user.id, name);
    return this.all()
      .filter((tree) => tree.engine.isInTree(user.id))
      .map((tree) => tree.execute(user.id, { fn: "changeName", args: { name } }));
  }
}

function parseSettings(body: unknown): CommunitySettings {
  const { name, description = "", visibility, joinPolicy } = (body ?? {}) as Record<
    string,
    unknown
  >;
  if (typeof name !== "string" || name.trim() === "" || name.trim().length > MAX_COMMUNITY_NAME) {
    throw new ActionError(`The name must be 1-${MAX_COMMUNITY_NAME} characters.`);
  }
  if (typeof description !== "string" || description.trim().length > MAX_DESCRIPTION) {
    throw new ActionError(`The description can be at most ${MAX_DESCRIPTION} characters.`);
  }
  if (visibility !== "public" && visibility !== "private") {
    throw new ActionError("Choose whether the community is public or private.");
  }
  if (joinPolicy !== "open" && joinPolicy !== "invite") {
    throw new ActionError("Choose whether anyone can join or only people with an invite.");
  }
  return {
    name: name.trim(),
    description: description.trim(),
    visibility,
    // nobody outside a private community can see where to join
    joinPolicy: visibility === "private" ? "invite" : joinPolicy,
  };
}

function parseName(v: unknown): string {
  if (typeof v !== "string" || v.trim() === "" || v.trim().length > MAX_NAME_LENGTH) {
    throw new ActionError(`Names must be 1-${MAX_NAME_LENGTH} characters.`);
  }
  return v.trim();
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
  const name = () => parseName(args.name);

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
