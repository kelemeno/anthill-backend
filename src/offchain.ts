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
// "invite" (always the case for private ones) an invite is required; in an
// "open" one anyone can join under any node with a free spot; a "closed" one
// takes nobody new (except through an admin's invite). Any other policy is
// treated as closed to newcomers without an invite.

import { randomBytes } from "node:crypto";
import { AnthillEngine, address0, address1, type EngineEvent, Revert, tempAddress } from "./engine";
import { explain } from "./reasons";
import {
  type Action,
  type ActionEntry,
  type CommunityInfo,
  type CommunitySettings,
  type Invite,
  type Store,
  type StoredUser,
} from "./store";

export const MAX_NAME_LENGTH = 40;
const CLOSED = "This community isn't taking new members.";
const MAX_WEIGHT = 100n;
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_OPEN_INVITES = 10;
const MAX_COMMUNITY_NAME = 60;
const MAX_DESCRIPTION = 280;
const MAX_COMMUNITIES_PER_FOUNDER = 10;
// Lowercase letters, digits and dashes, 3-32 long; used in URLs (/c/<id>).
const COMMUNITY_ID = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const RESERVED_IDS = new Set(["admin", "api", "c", "demo", "new", "p", "invite", "settings", "www"]);
// The engine's sentinels, never a person: the contract lets you join or move
// under its scratch node (whose sentTreeVote stays address1 after a move),
// which would put you in a branch the root doesn't reach.
const SENTINELS = new Set([address0, address1, tempAddress]);
const NOT_IN_TREE = "Join the tree first.";

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
    return viewer !== undefined && (viewer === createdBy || this.isMember(viewer));
  }

  // In the tree and reachable from its root. The engine's isInTree is also
  // true for its scratch node and anyone placed under it, a branch the served
  // graph (crawled from the root) never shows; the API never lets anyone get
  // there, and treats whoever is there as outside the tree.
  isMember(id: string): boolean {
    if (SENTINELS.has(id) || !this.engine.isInTree(id)) return false;
    const seen = new Set<string>();
    let at = id;
    for (let parent = this.engine.parent(at); parent !== address1; parent = this.engine.parent(at)) {
      if (parent === address0 || SENTINELS.has(parent) || seen.has(parent)) return false;
      seen.add(parent);
      at = parent;
    }
    return at === this.engine.root();
  }

  // Members the root doesn't reach (see isMember); reported on startup.
  detached(): string[] {
    return this.engine.members().filter((id) => !this.isMember(id));
  }

  // Validate, run and persist one action by a signed-in user.
  execute(by: string, body: unknown): Executed {
    const action = this.prepare(by, parseAction(body));
    let events: EngineEvent[];
    let entry: ActionEntry | undefined;
    let applied = false;
    try {
      events = this.engine.run((e) => {
        apply(e, by, action);
        applied = true;
        // logged inside the run: if the write fails (a full disk), the engine
        // is rolled back too, so it never holds what the log doesn't
        entry = this.store.appendAction(this.id, by, action);
      });
    } catch (e) {
      if (applied) throw e;
      throw this.toActionError(by, action, e);
    }
    return { tree: this, entry: entry!, events };
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
        // a bug, not a reason: logged, and the other items still get answers
        console.error("check:", body, error);
        return { ok: false, reason: "That isn't possible right now.", code: "internal" };
      }
    });
  }

  // Everyone `voter` could endorse right now but doesn't yet.
  reach(voter: string): string[] {
    if (!this.isMember(voter)) return [];
    return this.engine.members().filter((m) => {
      if (m === voter) return false;
      const { votable, voted } = this.engine.dagVoteState(voter, m);
      return votable && !voted;
    });
  }

  ////////////////////////////////////////////
  //// invites

  createInvite(by: string): Invite {
    if (this.info.joinPolicy === "closed") throw new ActionError(CLOSED);
    if (!this.isMember(by)) {
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
    if (!this.isMember(under)) {
      throw new ActionError("That node isn't in the tree.");
    }
    return this.storeInvite("admin", under);
  }

  private storeInvite(by: string, under: string): Invite {
    const invite: Invite = {
      code: randomBytes(12).toString("base64url"),
      community: this.id,
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
    if (invite === undefined || this.store.communityOf(invite) !== this.id) {
      throw new ActionError("This invite link isn't valid.");
    }
    if (invite.usedBy !== undefined) {
      throw new ActionError("This invite has already been used.");
    }
    // a closed community takes nobody new, except through an admin's invite
    if (this.info.joinPolicy === "closed" && invite.by !== "admin") throw new ActionError(CLOSED);
    if (invite.expires < new Date().toISOString()) {
      throw new ActionError("This invite has expired. Ask for a new one.");
    }
    if (!this.isMember(invite.under)) {
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

  // Resolve invite placement, enforce the join policy and the rules the
  // server adds before the engine runs. Also answers what's refused anyway
  // without running the engine (each run clones the whole state).
  private prepare(by: string, action: Action): Action {
    const { joinPolicy, createdBy } = this.info;
    if (action.fn === "joinTree" || action.fn === "joinTreeAsRoot") {
      // A node takes the account's name, not the one the client sent (a page
      // signed in before a rename elsewhere still has the old one); joining
      // also sets the account name (see Store.apply), so it can't change it.
      // People without an account (the demo's scripted members) keep theirs.
      const account = this.store.user(by)?.name;
      if (account) action = { ...action, args: { ...action.args, name: account } } as Action;
    }
    if (action.fn === "joinTreeAsRoot") {
      // Only possible in an empty tree (the engine checks that). Starting it
      // is up to the founder; without one (a fresh data dir's commons) anyone
      // can, unless it's closed: the join policy is about joining a tree
      // someone started, and an invite needs someone in it to give one.
      if (createdBy !== "" ? by !== createdBy : joinPolicy === "closed") {
        throw new ActionError("Only the founder can start this community's tree.");
      }
      return action;
    }
    if (action.fn !== "joinTree") {
      // everything else needs a place in the tree (leaving is always allowed
      // to whoever the engine has in it)
      if (!this.engine.isInTree(by) || (action.fn !== "leaveTree" && !this.isMember(by))) {
        throw new ActionError(NOT_IN_TREE, "not in tree");
      }
      if (
        (action.fn === "moveTreeVote" || action.fn === "addDagVote") &&
        !this.isMember(action.args.recipient)
      ) {
        throw new ActionError("That person isn't in the tree.", "A mTV 3");
      }
      return action;
    }
    const { invite } = action.args;
    if (joinPolicy === "closed" && (invite === undefined || this.store.invite(invite)?.by !== "admin")) {
      throw new ActionError(CLOSED);
    }
    if (invite === undefined) {
      if (joinPolicy !== "open") {
        throw new ActionError("Joining needs an invite from someone in the community.");
      }
      if (!this.engine.isInTree(by) && !this.isMember(action.args.recipient)) {
        throw new ActionError("That person isn't in the tree.", "A lT 3");
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
      this.trees.get(this.store.originalCommunity)!.engine.loadFromGraph(seed);
    }
    // the log as it was when the load started: an action appended meanwhile is
    // already in its engine
    const entries = this.store.actions.slice();
    for (const entry of entries) {
      const tree = this.trees.get(this.store.communityOf(entry));
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
  // Returns whether anything changed (unchanged settings aren't logged).
  updateSettings(by: string, tree: OffchainTree, body: unknown): boolean {
    if (by !== tree.info.createdBy) {
      throw new ActionError("Only the founder can change the community's settings.");
    }
    const settings = parseSettings(body);
    const info = tree.info;
    if ((Object.keys(settings) as (keyof CommunitySettings)[]).every((k) => settings[k] === info[k])) {
      return false;
    }
    this.store.updateCommunity(tree.id, settings);
    return true;
  }

  // Rename an account, and its node in every tree it's a member of (a node
  // the root doesn't reach can't act, so it keeps its name rather than making
  // the whole rename fail). Unchanged names are skipped: each rename is a
  // history step everywhere.
  rename(user: StoredUser, body: unknown): Executed[] {
    const name = parseName((body as { name?: unknown } | null)?.name);
    if (this.store.user(user.id)?.name !== name) this.store.setUserName(user.id, name);
    return this.all()
      .filter((tree) => tree.isMember(user.id) && tree.engine.name(user.id) !== name)
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
  if (joinPolicy !== "open" && joinPolicy !== "invite" && joinPolicy !== "closed") {
    throw new ActionError("Choose who can join: anyone, people with an invite, or nobody for now.");
  }
  return {
    name: name.trim(),
    description: description.trim(),
    visibility,
    // nobody outside a private community can see where to join
    joinPolicy: visibility === "private" && joinPolicy === "open" ? "invite" : joinPolicy,
  };
}

// Characters that show as nothing or change how the text around them is
// drawn: controls and line breaks, zero-width and bidi format characters
// (\p{Cf}, which also has U+200B, U+200E-200F, U+202A-202E, U+2066-2069 and
// the BOM), and the blank-looking letters and symbols trim() keeps (Hangul
// fillers, the braille blank). They'd let a name look empty, or like someone
// else's. Two kinds of format character are kept where text needs them:
// tag characters in a subdivision flag (🏴 + tags, e.g. Scotland's; matched
// first, as group 1, and put back), and the zero-width (non-)joiners, which
// STRAY_JOINER handles.
const INVISIBLE =
  /(\u{1F3F4}[\u{E0020}-\u{E007E}]{1,30}\u{E007F})|(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u2800\u3164\uFFA0]/gu;
// ZWJ and ZWNJ join emoji (👨‍👩‍👧, 🏳️‍🌈) and shape Arabic-script and Indic
// words (Persian names, conjuncts); anywhere else (between Latin letters, next
// to a space, at either end) they're invisible, so they go.
const STRAY_JOINER =
  /(?<![\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\p{sc=Arab}\p{sc=Syrc}\p{sc=Nkoo}\p{sc=Mong}\p{sc=Deva}\p{sc=Beng}\p{sc=Guru}\p{sc=Gujr}\p{sc=Orya}\p{sc=Taml}\p{sc=Telu}\p{sc=Knda}\p{sc=Mlym}\p{sc=Sinh}])[\u200C\u200D]|[\u200C\u200D](?=[\s\u200C\u200D]|$)/gu;

// An account or node name as it's stored: invisible characters taken out,
// runs of spaces made one, trimmed, 1-40 characters.
export function parseName(v: unknown): string {
  const name =
    typeof v === "string"
      ? v
          .normalize("NFC")
          .replace(INVISIBLE, (_, flag: string | undefined) => flag ?? "")
          .replace(STRAY_JOINER, "")
          .replace(/\s+/gu, " ")
          .trim()
      : "";
  if (name === "" || name.length > MAX_NAME_LENGTH) {
    throw new ActionError(`Names must be 1-${MAX_NAME_LENGTH} characters.`);
  }
  return name;
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
  const { fn, args: rawArgs } = body as { fn?: unknown; args?: unknown };
  // a default only replaces undefined: null (or a string) must not reach args[key]
  if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))) {
    throw new ActionError("args must be an object");
  }
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  const id = (key: string) => {
    const v = args[key];
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
      throw new ActionError(`${key} must be a 20-byte hex id`);
    }
    if (SENTINELS.has(v.toLowerCase())) throw new ActionError("That person isn't in the tree.");
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
