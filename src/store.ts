// Append-only log that is the off-chain source of truth. Each line of
// <DATA_DIR>/log.jsonl is one entry: the seed graph, a community, a tree
// action, or a change to passkeys, invites, profiles or polls. On startup the
// engines and everything else are rebuilt by replaying the log in order.
//
// Trees, invites and polls belong to a community; entries written before
// communities existed have no community field and belong to the default one
// (the original public tree). Accounts and profiles are shared by all.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SeedGraph } from "./engine";

export type StoredUser = { id: string; name: string };

export const DEFAULT_COMMUNITY = "commons";

export type CommunityInfo = {
  id: string;
  name: string;
  description: string;
  // private: only members can see it
  visibility: "public" | "private";
  // open: anyone signed in can join at a free spot; invite: invite link only
  joinPolicy: "open" | "invite";
  createdBy: string;
  createdAt: string;
};

export type CommunitySettings = Pick<CommunityInfo, "name" | "description" | "visibility" | "joinPolicy">;

// The original tree, which every log has implicitly. Settings changes are
// stored like any other community's.
function defaultCommunity(): CommunityInfo {
  return {
    id: DEFAULT_COMMUNITY,
    name: "Anthill Commons",
    description: "The public tree everyone can explore.",
    visibility: "public",
    joinPolicy: process.env.INVITE_ONLY === "true" ? "invite" : "open",
    createdBy: "",
    createdAt: "",
  };
}

export function communityOf(entry: { community?: string }): string {
  return entry.community ?? DEFAULT_COMMUNITY;
}

export type StoredPasskey = {
  id: string;
  userId: string;
  publicKey: string; // base64url
  counter: number;
  transports?: string[];
};

export type Action =
  | { fn: "joinTree"; args: { name: string; recipient: string; invite?: string } }
  | { fn: "joinTreeAsRoot"; args: { name: string } }
  | { fn: "changeName"; args: { name: string } }
  | { fn: "addDagVote"; args: { recipient: string; weight: string } }
  | { fn: "removeDagVote"; args: { recipient: string } }
  | { fn: "leaveTree"; args: Record<string, never> }
  | { fn: "switchPositionWithParent"; args: Record<string, never> }
  | { fn: "moveTreeVote"; args: { recipient: string } };

export type ActionEntry = {
  type: "action";
  at: string;
  by: string;
  action: Action;
  community?: string;
};

// `by` is the inviting user's id, or "admin". The invitee joins under `under`
// (or the nearest free spot below it).
export type Invite = {
  code: string;
  community?: string;
  by: string;
  under: string;
  expires: string;
  usedBy?: string;
};

export type Profile = { bio: string; link: string };

export type Poll = {
  id: string;
  community: string;
  by: string;
  at: string;
  question: string;
  options: string[];
  // voter id -> option index
  votes: Map<string, number>;
  // set when closed: the reputation-weighted total per option at that moment
  closed?: { at: string; tally: string[] };
};

type Entry =
  | { type: "seed"; at: string; graph: SeedGraph }
  | { type: "community"; at: string; community: CommunityInfo }
  | { type: "communityUpdate"; at: string; id: string; settings: CommunitySettings }
  | { type: "passkey"; at: string; user: StoredUser; passkey: StoredPasskey }
  | { type: "passkeyAdded"; at: string; passkey: StoredPasskey }
  | { type: "counter"; at: string; id: string; counter: number }
  | { type: "recovery"; at: string; userId: string; hash: string }
  | { type: "name"; at: string; userId: string; name: string }
  | { type: "invite"; at: string; invite: Invite }
  | { type: "profile"; at: string; userId: string; bio: string; link: string }
  | {
      type: "poll";
      at: string;
      id: string;
      community?: string;
      by: string;
      question: string;
      options: string[];
    }
  | { type: "pollVote"; at: string; pollId: string; by: string; option: number }
  | { type: "pollClose"; at: string; pollId: string; tally: string[] }
  | ActionEntry;

export class Store {
  readonly logPath: string;
  private secretPath: string;
  private users = new Map<string, StoredUser>();
  private passkeys = new Map<string, StoredPasskey>();
  private recoveryHashes = new Map<string, string>(); // userId -> hash
  private invites = new Map<string, Invite>();
  private profiles = new Map<string, Profile>();
  private pollsById = new Map<string, Poll>();
  private communityById = new Map<string, CommunityInfo>([[DEFAULT_COMMUNITY, defaultCommunity()]]);
  private seedGraph: SeedGraph | undefined;
  private actionEntries: ActionEntry[] = [];

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.logPath = join(dir, "log.jsonl");
    this.secretPath = join(dir, "session-secret");

    if (!existsSync(this.logPath)) {
      return;
    }
    for (const line of readFileSync(this.logPath, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      this.apply(JSON.parse(line, bigintReviver) as Entry);
    }
  }

  get seed() {
    return this.seedGraph;
  }

  get actions(): readonly ActionEntry[] {
    return this.actionEntries;
  }

  setSeed(graph: SeedGraph) {
    if (this.seedGraph !== undefined || this.actionEntries.length > 0) {
      throw new Error("the log already has a seed or actions");
    }
    this.append({ type: "seed", at: now(), graph });
  }

  appendAction(community: string, by: string, action: Action): ActionEntry {
    const entry: ActionEntry = { type: "action", at: now(), by, action };
    if (community !== DEFAULT_COMMUNITY) entry.community = community;
    this.append(entry);
    return entry;
  }

  ////////////////////////////////////////////
  //// communities

  addCommunity(community: CommunityInfo) {
    this.append({ type: "community", at: now(), community });
  }

  updateCommunity(id: string, settings: CommunitySettings) {
    this.append({ type: "communityUpdate", at: now(), id, settings });
  }

  community(id: string) {
    return this.communityById.get(id);
  }

  communities() {
    return [...this.communityById.values()];
  }

  ////////////////////////////////////////////
  //// users and passkeys

  user(id: string) {
    return this.users.get(id);
  }

  passkey(id: string) {
    return this.passkeys.get(id);
  }

  passkeysOf(userId: string) {
    return [...this.passkeys.values()].filter((p) => p.userId === userId);
  }

  addPasskey(user: StoredUser, passkey: StoredPasskey) {
    this.append({ type: "passkey", at: now(), user, passkey });
  }

  // Another passkey for an existing user (a new device, or after recovery).
  addPasskeyToUser(passkey: StoredPasskey) {
    this.append({ type: "passkeyAdded", at: now(), passkey });
  }

  setPasskeyCounter(id: string, counter: number) {
    if (this.passkeys.get(id)?.counter === counter) return;
    this.append({ type: "counter", at: now(), id, counter });
  }

  setRecoveryHash(userId: string, hash: string) {
    this.append({ type: "recovery", at: now(), userId, hash });
  }

  // The account name. Joining or renaming in a tree also sets it (see apply).
  setUserName(userId: string, name: string) {
    this.append({ type: "name", at: now(), userId, name });
  }

  userByRecoveryHash(hash: string) {
    for (const [userId, h] of this.recoveryHashes) {
      if (h === hash) return this.users.get(userId);
    }
    return undefined;
  }

  ////////////////////////////////////////////
  //// invites

  addInvite(invite: Invite) {
    this.append({ type: "invite", at: now(), invite });
  }

  invite(code: string) {
    return this.invites.get(code);
  }

  openInvitesBy(community: string, by: string) {
    const nowIso = now();
    return [...this.invites.values()].filter(
      (i) =>
        communityOf(i) === community && i.by === by && i.usedBy === undefined && i.expires > nowIso,
    );
  }

  ////////////////////////////////////////////
  //// profiles

  setProfile(userId: string, profile: Profile) {
    this.append({ type: "profile", at: now(), userId, ...profile });
  }

  profile(userId: string) {
    return this.profiles.get(userId);
  }

  ////////////////////////////////////////////
  //// polls

  addPoll(community: string, id: string, by: string, question: string, options: string[]) {
    const entry: Entry = { type: "poll", at: now(), id, by, question, options };
    if (community !== DEFAULT_COMMUNITY) entry.community = community;
    this.append(entry);
  }

  votePoll(pollId: string, by: string, option: number) {
    this.append({ type: "pollVote", at: now(), pollId, by, option });
  }

  closePoll(pollId: string, tally: string[]) {
    this.append({ type: "pollClose", at: now(), pollId, tally });
  }

  poll(id: string) {
    return this.pollsById.get(id);
  }

  polls(community: string) {
    return [...this.pollsById.values()].filter((p) => p.community === community);
  }

  sessionSecret(generate: () => string): string {
    if (!existsSync(this.secretPath)) {
      writeFileSync(this.secretPath, generate(), { mode: 0o600 });
    }
    return readFileSync(this.secretPath, "utf8").trim();
  }

  private append(entry: Entry) {
    appendFileSync(this.logPath, `${JSON.stringify(entry, bigintReplacer)}\n`);
    this.apply(entry);
  }

  private apply(entry: Entry) {
    switch (entry.type) {
      case "seed":
        this.seedGraph = entry.graph;
        break;
      case "community":
        this.communityById.set(entry.community.id, { ...entry.community });
        break;
      case "communityUpdate": {
        const c = this.communityById.get(entry.id);
        if (c !== undefined) this.communityById.set(entry.id, { ...c, ...entry.settings });
        break;
      }
      case "passkey":
        this.users.set(entry.user.id, { ...entry.user });
        this.passkeys.set(entry.passkey.id, { ...entry.passkey });
        break;
      case "passkeyAdded":
        this.passkeys.set(entry.passkey.id, { ...entry.passkey });
        break;
      case "counter": {
        const passkey = this.passkeys.get(entry.id);
        if (passkey !== undefined) passkey.counter = entry.counter;
        break;
      }
      case "recovery":
        this.recoveryHashes.set(entry.userId, entry.hash);
        break;
      case "name": {
        const user = this.users.get(entry.userId);
        if (user !== undefined) user.name = entry.name;
        break;
      }
      case "invite":
        this.invites.set(entry.invite.code, { ...entry.invite });
        break;
      case "profile":
        this.profiles.set(entry.userId, { bio: entry.bio, link: entry.link });
        break;
      case "poll":
        this.pollsById.set(entry.id, {
          id: entry.id,
          community: communityOf(entry),
          by: entry.by,
          at: entry.at,
          question: entry.question,
          options: entry.options,
          votes: new Map(),
        });
        break;
      case "pollVote":
        this.pollsById.get(entry.pollId)?.votes.set(entry.by, entry.option);
        break;
      case "pollClose": {
        const poll = this.pollsById.get(entry.pollId);
        if (poll !== undefined) poll.closed = { at: entry.at, tally: entry.tally };
        break;
      }
      case "action": {
        this.actionEntries.push(entry);
        const { action } = entry;
        if (action.fn === "changeName" || action.fn === "joinTree") {
          const user = this.users.get(entry.by);
          if (user !== undefined) user.name = action.args.name;
        }
        if (action.fn === "joinTree" && action.args.invite !== undefined) {
          const invite = this.invites.get(action.args.invite);
          if (invite !== undefined) invite.usedBy = entry.by;
        }
        break;
      }
    }
  }
}

function now() {
  return new Date().toISOString();
}

// JSON (de)serialisation that survives bigints, same encoding as the snapshot.
export function bigintReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? { __bigint__: value.toString() } : value;
}

export function bigintReviver(_key: string, value: unknown) {
  if (
    value !== null &&
    typeof value === "object" &&
    "__bigint__" in value &&
    typeof (value as { __bigint__: unknown }).__bigint__ === "string"
  ) {
    return BigInt((value as { __bigint__: string }).__bigint__);
  }
  return value;
}
