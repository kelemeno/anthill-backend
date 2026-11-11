// Append-only log that is the off-chain source of truth. Each line of
// <DATA_DIR>/log.jsonl is one entry: the seed graph, a community, a tree
// action, or a change to passkeys, invites, profiles or polls. On startup the
// engines and everything else are rebuilt by replaying the log in order.
//
// Trees, invites and polls belong to a community. Entries written before
// communities existed have no community field: they belong to the original
// tree, which grew from the seed. That tree started out as the commons and was
// later moved to a demo community (a "commonsMoved" entry), leaving the
// commons empty for real members. Entries are always tagged now. Accounts and
// profiles are shared by all communities.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  truncateSync,
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
  // open: anyone signed in can join at a free spot; invite: invite link only;
  // closed: nobody new (e.g. the demo)
  joinPolicy: "open" | "invite" | "closed";
  createdBy: string;
  createdAt: string;
};

export type CommunitySettings = Pick<CommunityInfo, "name" | "description" | "visibility" | "joinPolicy">;

// How the log stores a join policy. "closed" is written as "invite" plus
// closed: true, because code from before "closed" existed treats any policy
// but "invite" as open: rolled back to it, a closed community becomes invite
// only, not open to anyone. Older entries hold "closed" itself, read the same.
type Stored<T extends { joinPolicy: CommunityInfo["joinPolicy"] }> = Omit<T, "joinPolicy"> & {
  joinPolicy: CommunityInfo["joinPolicy"];
  closed?: boolean;
};

function toStored<T extends { joinPolicy: CommunityInfo["joinPolicy"] }>(x: T): Stored<T> {
  return x.joinPolicy === "closed" ? { ...x, joinPolicy: "invite", closed: true } : { ...x, closed: false };
}

function fromStored<T extends { joinPolicy: CommunityInfo["joinPolicy"] }>(x: Stored<T>): T {
  const { closed, ...rest } = x;
  return (closed === true ? { ...rest, joinPolicy: "closed" } : rest) as unknown as T;
}

// The commons, which every log has implicitly. Settings changes are stored
// like any other community's.
function defaultCommunity(): CommunityInfo {
  return {
    id: DEFAULT_COMMUNITY,
    name: "Anthill Commons",
    description: "The public community anyone can join.",
    visibility: "public",
    joinPolicy: process.env.INVITE_ONLY === "true" ? "invite" : "open",
    createdBy: "",
    createdAt: "",
  };
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
  // see Store.communityOf
  community?: string;
  by: string;
  at: string;
  question: string;
  options: string[];
  // voter id -> option index
  votes: Map<string, number>;
  // voter id -> when they last voted
  votedAt: Map<string, string>;
  // set when closed: the reputation-weighted total per option at that moment,
  // and (closed since it's logged) how many counted voters each had
  closed?: { at: string; tally: string[]; voters?: number[] };
};

type Entry =
  | { type: "seed"; at: string; graph: SeedGraph }
  | { type: "community"; at: string; community: Stored<CommunityInfo> }
  | { type: "communityUpdate"; at: string; id: string; settings: Stored<CommunitySettings> }
  | { type: "commonsMoved"; at: string; to: Stored<CommunityInfo>; commonsFounder: string }
  // a one-time change made on startup (e.g. the demo's story), so it isn't redone
  | { type: "migration"; at: string; id: string }
  | { type: "passkey"; at: string; user: StoredUser; passkey: StoredPasskey }
  | { type: "passkeyAdded"; at: string; passkey: StoredPasskey }
  | { type: "counter"; at: string; id: string; counter: number }
  | { type: "recovery"; at: string; userId: string; hash: string }
  // ends every session of the user (bumps its session version)
  | { type: "signOutAll"; at: string; userId: string }
  // a completed recovery: the new passkey replaces the user's others, the code
  // is replaced and every session ends, all at once
  | { type: "recovered"; at: string; userId: string; passkey: StoredPasskey; hash: string }
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
  | { type: "pollClose"; at: string; pollId: string; tally: string[]; voters?: number[] }
  | ActionEntry;

export class Store {
  readonly logPath: string;
  private secretPath: string;
  private users = new Map<string, StoredUser>();
  private passkeys = new Map<string, StoredPasskey>();
  private recoveryHashes = new Map<string, string>(); // userId -> hash
  private sessionVersions = new Map<string, number>(); // userId -> version, default 0
  private invites = new Map<string, Invite>();
  private profiles = new Map<string, Profile>();
  private pollsById = new Map<string, Poll>();
  private communityById = new Map<string, CommunityInfo>([[DEFAULT_COMMUNITY, defaultCommunity()]]);
  private seedGraph: SeedGraph | undefined;
  // where untagged entries (the original tree) belong
  private originalTree = DEFAULT_COMMUNITY;
  private migrations = new Set<string>();
  private actionEntries: ActionEntry[] = [];
  // "<entry's community field> <user>" -> when they last joined that tree
  // (untagged entries are resolved when asked: see communityOf)
  private joins = new Map<string, string>();
  // the log may not end with a newline (a write was cut short): the next entry
  // starts on a new line
  private needsNewline = false;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.logPath = join(dir, "log.jsonl");
    this.secretPath = join(dir, "session-secret");

    if (!existsSync(this.logPath)) {
      return;
    }
    const raw = readFileSync(this.logPath);
    const lines = raw.toString("utf8").split("\n");
    let lastLine = lines.length - 1;
    while (lastLine > 0 && lines[lastLine].trim() === "") lastLine--;
    let offset = 0; // bytes before the current line
    let torn = false;
    for (const [i, line] of lines.entries()) {
      const start = offset;
      offset += Buffer.byteLength(line) + 1;
      if (line.trim() === "") continue;
      let entry: Entry;
      try {
        entry = JSON.parse(line, bigintReviver) as Entry;
      } catch (e) {
        if (i !== lastLine) throw new Error(`${this.logPath} line ${i + 1} is corrupt: ${e}`);
        // A crash or a full disk in the middle of the last write: that entry
        // never happened. Keep its bytes aside and cut it off, so the log
        // stays one entry per line.
        // (Keeping them can fail on the full disk that cut them short: the
        // log then just shows their start, and they're cut off anyway.)
        const tornBytes = raw.subarray(start);
        const aside = `${this.logPath}.torn-${now().replace(/[:.]/g, "-")}`;
        let kept = `kept in ${aside}`;
        try {
          writeFileSync(aside, tornBytes);
        } catch (e) {
          kept = `not kept (${e}); they began ${JSON.stringify(tornBytes.subarray(0, 200).toString("utf8"))}`;
        }
        truncateSync(this.logPath, start);
        torn = true;
        console.error(
          `WARNING: the last line of ${this.logPath} was cut short and is skipped (${tornBytes.length} bytes, ${kept}).`,
        );
        break;
      }
      this.apply(entry);
    }
    // a complete last entry whose newline wasn't written
    this.needsNewline = !torn && raw.length > 0 && raw[raw.length - 1] !== 0x0a;
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
    const entry: ActionEntry = { type: "action", at: now(), by, action, community };
    this.append(entry);
    return entry;
  }

  // The community an entry belongs to.
  communityOf(entry: { community?: string }): string {
    return entry.community ?? this.originalTree;
  }

  // The community the seed and the untagged entries belong to.
  get originalCommunity() {
    return this.originalTree;
  }

  // Move the original tree (the seed and everything done in it so far) to
  // its own community, and start the commons over, empty, with a founder who
  // starts its tree.
  moveCommons(to: CommunityInfo, commonsFounder: string) {
    if (this.originalTree !== DEFAULT_COMMUNITY) throw new Error("already moved");
    this.append({ type: "commonsMoved", at: now(), to: toStored(to), commonsFounder });
  }

  // One-time changes made on startup.
  hasMigration(id: string) {
    return this.migrations.has(id);
  }

  markMigration(id: string) {
    this.append({ type: "migration", at: now(), id });
  }

  ////////////////////////////////////////////
  //// communities

  addCommunity(community: CommunityInfo) {
    this.append({ type: "community", at: now(), community: toStored(community) });
  }

  updateCommunity(id: string, settings: CommunitySettings) {
    this.append({ type: "communityUpdate", at: now(), id, settings: toStored(settings) });
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

  recoveryHashOf(userId: string) {
    return this.recoveryHashes.get(userId);
  }

  recover(userId: string, passkey: StoredPasskey, hash: string) {
    this.append({ type: "recovered", at: now(), userId, passkey, hash });
  }

  // Session tokens carry this; a token with an older one is refused.
  sessionVersion(userId: string) {
    return this.sessionVersions.get(userId) ?? 0;
  }

  signOutAll(userId: string) {
    this.append({ type: "signOutAll", at: now(), userId });
  }

  // The account name. Joining or renaming in a tree also sets it (see apply):
  // old entries may carry another name; new ones always carry this one.
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
        this.communityOf(i) === community &&
        i.by === by &&
        i.usedBy === undefined &&
        i.expires > nowIso,
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
    this.append({ type: "poll", at: now(), id, community, by, question, options });
  }

  votePoll(pollId: string, by: string, option: number) {
    this.append({ type: "pollVote", at: now(), pollId, by, option });
  }

  closePoll(pollId: string, tally: string[], voters: number[]) {
    this.append({ type: "pollClose", at: now(), pollId, tally, voters });
  }

  poll(id: string) {
    return this.pollsById.get(id);
  }

  polls(community: string) {
    return [...this.pollsById.values()].filter((p) => this.communityOf(p) === community);
  }

  // When `userId` last joined the community's tree (undefined: never through
  // the log, e.g. the seeded members).
  joinedAt(community: string, userId: string) {
    const tagged = this.joins.get(`${community} ${userId}`);
    const untagged = community === this.originalTree ? this.joins.get(` ${userId}`) : undefined;
    return untagged === undefined || (tagged !== undefined && tagged > untagged) ? tagged : untagged;
  }

  sessionSecret(generate: () => string): string {
    if (!existsSync(this.secretPath)) {
      writeFileSync(this.secretPath, generate(), { mode: 0o600 });
    }
    return readFileSync(this.secretPath, "utf8").trim();
  }

  // Written before it's applied, so memory never holds what the log doesn't.
  private append(entry: Entry) {
    const line = `${JSON.stringify(entry, bigintReplacer)}\n`;
    const sizeBefore = existsSync(this.logPath) ? statSync(this.logPath).size : 0;
    try {
      appendFileSync(this.logPath, this.needsNewline ? `\n${line}` : line);
    } catch (e) {
      // Part of the line may have been written (a full disk): cut it off, or
      // the next entry would leave it as a corrupt line mid-log, which stops
      // the server from starting.
      try {
        if (existsSync(this.logPath) && statSync(this.logPath).size !== sizeBefore) {
          truncateSync(this.logPath, sizeBefore);
        }
      } catch (cut) {
        // at least the next entry starts on its own line
        this.needsNewline = true;
        console.error(
          `WARNING: a failed write to ${this.logPath} may have left part of a line at byte ${sizeBefore}, which couldn't be cut off (${cut}). Remove it before the next start.`,
        );
      }
      throw e;
    }
    this.needsNewline = false;
    this.apply(entry);
  }

  private apply(entry: Entry) {
    switch (entry.type) {
      case "seed":
        this.seedGraph = entry.graph;
        break;
      case "community":
        this.communityById.set(entry.community.id, fromStored(entry.community));
        break;
      case "commonsMoved":
        this.communityById.set(entry.to.id, fromStored(entry.to));
        this.communityById.set(DEFAULT_COMMUNITY, {
          ...defaultCommunity(),
          createdBy: entry.commonsFounder,
          createdAt: entry.at,
        });
        this.originalTree = entry.to.id;
        break;
      case "migration":
        this.migrations.add(entry.id);
        break;
      case "communityUpdate": {
        const c = this.communityById.get(entry.id);
        if (c !== undefined) this.communityById.set(entry.id, { ...c, ...fromStored(entry.settings) });
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
      case "signOutAll":
        this.sessionVersions.set(entry.userId, this.sessionVersion(entry.userId) + 1);
        break;
      case "recovered":
        for (const p of this.passkeysOf(entry.userId)) this.passkeys.delete(p.id);
        this.passkeys.set(entry.passkey.id, { ...entry.passkey });
        this.recoveryHashes.set(entry.userId, entry.hash);
        this.sessionVersions.set(entry.userId, this.sessionVersion(entry.userId) + 1);
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
          community: entry.community,
          by: entry.by,
          at: entry.at,
          question: entry.question,
          options: entry.options,
          votes: new Map(),
          votedAt: new Map(),
        });
        break;
      case "pollVote": {
        const poll = this.pollsById.get(entry.pollId);
        poll?.votes.set(entry.by, entry.option);
        poll?.votedAt.set(entry.by, entry.at);
        break;
      }
      case "pollClose": {
        const poll = this.pollsById.get(entry.pollId);
        if (poll !== undefined) poll.closed = { at: entry.at, tally: entry.tally, voters: entry.voters };
        break;
      }
      case "action": {
        this.actionEntries.push(entry);
        const { action } = entry;
        if (action.fn === "changeName" || action.fn === "joinTree") {
          const user = this.users.get(entry.by);
          if (user !== undefined) user.name = action.args.name;
        }
        if (action.fn === "joinTree" || action.fn === "joinTreeAsRoot") {
          this.joins.set(`${entry.community ?? ""} ${entry.by}`, entry.at);
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
