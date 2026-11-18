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
//
// Accounts sign in with passkeys or Google (see auth.ts and google.ts). Each
// sign-in is logged as a session (no IP address, only a coarse device label),
// so people can see their sessions and end one; the log also records an
// account's deletion, after which it can never sign in again and its id is
// never reused: nothing new is written for it (or by it) from then on, so a
// request that was signed in just before can't bring it back. Entry types
// are only ever added: the production log has to replay unchanged.
//
// The one thing about an account kept outside the log is its Google email,
// in <DATA_DIR>/google-emails.json, so that unlinking Google, recovering
// (which unlinks it) or deleting the account really erases it: the log can
// never forget. The log has only Google's id for the account (`sub`). The
// file isn't part of replay: without it (or without an account in it) that
// account shows as "a Google account" until its next Google sign-in.

import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { AuthError } from "./auth";
import type { SeedGraph } from "./engine";

export type StoredUser = { id: string; name: string };

// What a deleted account is called from then on (in polls it created, say).
export const DELETED_NAME = "Deleted account";

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

// The Google account an Anthill account signs in with, as logged: Google's
// id for the person (`sub`, which never changes). Never the email (see the
// top).
export type GoogleLink = { sub: string };

// The Google account with the email Google last reported for it, which only
// the account holder sees. No email when the side file doesn't have it.
export type LinkedGoogle = GoogleLink & { email?: string };

// How a session was made: signing in with a passkey or Google, signing up
// with a passkey, or recovering with the recovery code.
export type SessionMethod = "passkey" | "google" | "register" | "recovery";

export type StoredSession = {
  sid: string;
  userId: string;
  method: SessionMethod;
  // e.g. "Chrome on macOS", from the User-Agent
  device: string;
  at: string;
  expires: string;
  // the credential id, for sessions made with a passkey
  passkey?: string;
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
  // is replaced, every session ends and Google is unlinked, all at once
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
  // a sign-in: its token carries the sid and is refused once the session ends
  | ({ type: "session" } & StoredSession)
  | { type: "sessionEnd"; at: string; userId: string; sid: string }
  | { type: "passkeyRemoved"; at: string; userId: string; id: string }
  // an account made by signing in with Google (it has no passkey yet)
  | { type: "googleAccount"; at: string; user: StoredUser; google: GoogleLink }
  // linked to an existing account (a new email for the same Google account
  // isn't logged: it only goes to the side file)
  | { type: "googleLinked"; at: string; userId: string; google: GoogleLink }
  | { type: "googleUnlinked"; at: string; userId: string }
  // the account is gone: no way to sign in, no profile, renamed, and the
  // communities it founded have no founder (it left their trees before this)
  | { type: "accountDeleted"; at: string; userId: string }
  | ActionEntry;

export type LogEntry = Entry;

export class Store {
  readonly logPath: string;
  private secretPath: string;
  private users = new Map<string, StoredUser>();
  private passkeys = new Map<string, StoredPasskey>();
  private recoveryHashes = new Map<string, string>(); // userId -> hash
  private sessionVersions = new Map<string, number>(); // userId -> version, default 0
  // userId -> sid -> its session, for the ones that haven't ended (expired
  // ones are dropped as the user signs in again)
  private sessions = new Map<string, Map<string, StoredSession>>();
  private passkeyAddedAt = new Map<string, string>(); // credential id -> when
  private passkeyUsedAt = new Map<string, string>(); // credential id -> newest session with it
  private googleOfUser = new Map<string, GoogleLink>(); // userId -> its Google account
  private userOfGoogle = new Map<string, string>(); // Google sub -> userId
  // userId -> its Google account and email, as in the side file (see the
  // top): only for accounts linked to that same Google account now
  private googleEmails = new Map<string, { sub: string; email: string }>();
  private googleEmailsPath: string;
  private deletedUsers = new Set<string>();
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
    this.googleEmailsPath = join(dir, "google-emails.json");
    if (existsSync(this.logPath)) this.replay();
    this.loadGoogleEmails();
  }

  private replay() {
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

  // Also unlinks Google (see apply), so its email goes too.
  recover(userId: string, passkey: StoredPasskey, hash: string) {
    this.append({ type: "recovered", at: now(), userId, passkey, hash });
    this.forgetGoogleEmail(userId);
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

  ////////////////////////////////////////////
  //// sessions

  startSession(session: Omit<StoredSession, "at">) {
    this.append({ type: "session", at: now(), ...session });
  }

  endSession(userId: string, sid: string) {
    this.append({ type: "sessionEnd", at: now(), userId, sid });
  }

  // The session, unless it ended (or never was).
  session(userId: string, sid: string) {
    return this.sessions.get(userId)?.get(sid);
  }

  // The user's sessions that are still open, newest first (in the log's
  // order, which is the order they were made in).
  sessionsOf(userId: string) {
    const nowIso = now();
    return [...(this.sessions.get(userId)?.values() ?? [])].reverse().filter((s) => s.expires > nowIso);
  }

  ////////////////////////////////////////////
  //// more about passkeys, Google, deletion

  removePasskey(userId: string, id: string) {
    this.append({ type: "passkeyRemoved", at: now(), userId, id });
  }

  // When the passkey was added, and when it last made a session (undefined
  // for sign-ins from before sessions were logged).
  passkeyDates(id: string) {
    return { addedAt: this.passkeyAddedAt.get(id), usedAt: this.passkeyUsedAt.get(id) };
  }

  // The log gets the sub, the side file the email (see the top).
  addGoogleUser(user: StoredUser, google: { sub: string; email: string }) {
    this.append({ type: "googleAccount", at: now(), user, google: { sub: google.sub } });
    this.setGoogleEmail(user.id, google.sub, google.email);
  }

  linkGoogle(userId: string, google: { sub: string; email: string }) {
    this.append({ type: "googleLinked", at: now(), userId, google: { sub: google.sub } });
    this.setGoogleEmail(userId, google.sub, google.email);
  }

  // The email Google reports now for the account's linked Google account
  // (on each sign-in with it): only the side file changes.
  googleEmailSeen(userId: string, email: string) {
    const google = this.googleOfUser.get(userId);
    if (google !== undefined) this.setGoogleEmail(userId, google.sub, email);
  }

  unlinkGoogle(userId: string) {
    this.append({ type: "googleUnlinked", at: now(), userId });
    this.forgetGoogleEmail(userId);
  }

  googleOf(userId: string): LinkedGoogle | undefined {
    const google = this.googleOfUser.get(userId);
    if (google === undefined) return undefined;
    const email = this.googleEmails.get(userId);
    return email?.sub === google.sub ? { sub: google.sub, email: email.email } : { sub: google.sub };
  }

  userByGoogleSub(sub: string) {
    const userId = this.userOfGoogle.get(sub);
    return userId === undefined ? undefined : this.users.get(userId);
  }

  deleteAccount(userId: string) {
    this.append({ type: "accountDeleted", at: now(), userId });
    this.forgetGoogleEmail(userId);
  }

  isDeleted(userId: string) {
    return this.deletedUsers.has(userId);
  }

  // Every entry in the log, oldest first, read a line at a time (for an
  // account's export: the log can be big, and this doesn't hold it all or
  // block other requests). A line being written meanwhile is skipped.
  async *entries(): AsyncGenerator<LogEntry> {
    if (!existsSync(this.logPath)) return;
    const lines = createInterface({ input: createReadStream(this.logPath), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim() === "") continue;
      try {
        yield JSON.parse(line, bigintReviver) as LogEntry;
      } catch {
        // the end of the log, cut short by a write in progress
      }
    }
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
  // Nothing is written by or about a deleted account (see the top): such a
  // write comes from a request that was signed in before the deletion.
  private append(entry: Entry) {
    if (accountsOf(entry).some((id) => this.deletedUsers.has(id))) throw new AuthError("session expired");
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

  ////////////////////////////////////////////
  //// the Google emails' side file (see the top)

  // Keeps only the emails of accounts linked to that same Google account
  // now: one left behind by a write that failed after an unlink, recovery or
  // deletion goes here, at the latest. An unreadable file counts as empty.
  private loadGoogleEmails() {
    let saved: unknown = {};
    let dropped = false;
    if (existsSync(this.googleEmailsPath)) {
      try {
        saved = JSON.parse(readFileSync(this.googleEmailsPath, "utf8"));
      } catch (e) {
        console.error(
          `WARNING: ${this.googleEmailsPath} couldn't be read (${e}); Google accounts show without their email until their next sign-in.`,
        );
        dropped = true;
      }
    }
    if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
      saved = {};
      dropped = true;
    }
    for (const [userId, value] of Object.entries(saved as object)) {
      const { sub, email } = (value ?? {}) as { sub?: unknown; email?: unknown };
      // not linked now, or to another Google account: stale
      const stale = typeof sub !== "string" || this.googleOfUser.get(userId)?.sub !== sub;
      if (stale || typeof email !== "string" || email === "") {
        dropped = true;
        continue;
      }
      this.googleEmails.set(userId, { sub, email });
    }
    if (dropped) this.saveGoogleEmails();
  }

  private setGoogleEmail(userId: string, sub: string, email: string) {
    const before = this.googleEmails.get(userId);
    if (before?.sub === sub && before.email === email) return;
    // Google may give no email: then none is kept
    if (email === "") this.googleEmails.delete(userId);
    else this.googleEmails.set(userId, { sub, email });
    this.saveGoogleEmails();
  }

  private forgetGoogleEmail(userId: string) {
    if (this.googleEmails.delete(userId)) this.saveGoogleEmails();
  }

  // The whole file, written to a temporary one and renamed over it, so a
  // crash leaves the old file or the new one, never half of one. It's only
  // read by the owner (like the session secret). If the write fails, memory
  // is still right; the next write, or the next start, puts the file right.
  // That isn't worth failing the request for: its log entry is in already.
  private saveGoogleEmails() {
    const temp = `${this.googleEmailsPath}.tmp`;
    try {
      // a leftover from a crash could have other permissions
      rmSync(temp, { force: true });
      const fd = openSync(temp, "w", 0o600);
      try {
        writeSync(fd, `${JSON.stringify(Object.fromEntries(this.googleEmails))}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.googleEmailsPath);
    } catch (e) {
      console.error(
        `WARNING: couldn't write ${this.googleEmailsPath} (${e}); it's put right by the next write or start.`,
      );
    }
  }

  private unlinkGoogleOf(userId: string) {
    const google = this.googleOfUser.get(userId);
    if (google !== undefined && this.userOfGoogle.get(google.sub) === userId) this.userOfGoogle.delete(google.sub);
    this.googleOfUser.delete(userId);
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
        this.passkeyAddedAt.set(entry.passkey.id, entry.at);
        break;
      case "passkeyAdded":
        this.passkeys.set(entry.passkey.id, { ...entry.passkey });
        this.passkeyAddedAt.set(entry.passkey.id, entry.at);
        break;
      case "passkeyRemoved":
        if (this.passkeys.get(entry.id)?.userId === entry.userId) this.passkeys.delete(entry.id);
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
        this.sessions.delete(entry.userId);
        break;
      case "recovered":
        // Everything someone with a lost device could have added goes: its
        // passkeys, sessions and a Google account linked from it. (Logs from
        // before Google have no link to remove, so they replay the same.)
        for (const p of this.passkeysOf(entry.userId)) this.passkeys.delete(p.id);
        this.passkeys.set(entry.passkey.id, { ...entry.passkey });
        this.passkeyAddedAt.set(entry.passkey.id, entry.at);
        this.recoveryHashes.set(entry.userId, entry.hash);
        this.sessionVersions.set(entry.userId, this.sessionVersion(entry.userId) + 1);
        this.sessions.delete(entry.userId);
        this.unlinkGoogleOf(entry.userId);
        break;
      case "session": {
        const { type: _, ...session } = entry;
        let open = this.sessions.get(entry.userId);
        if (open === undefined) {
          open = new Map();
          this.sessions.set(entry.userId, open);
        }
        // the user's expired sessions go, so the map only holds live ones
        for (const [sid, s] of open) if (s.expires < entry.at) open.delete(sid);
        open.set(entry.sid, session);
        if (entry.passkey !== undefined) this.passkeyUsedAt.set(entry.passkey, entry.at);
        break;
      }
      case "sessionEnd":
        this.sessions.get(entry.userId)?.delete(entry.sid);
        break;
      case "googleAccount":
        this.users.set(entry.user.id, { ...entry.user });
        // only the sub (entries from before the email left the log had it)
        this.googleOfUser.set(entry.user.id, { sub: entry.google.sub });
        this.userOfGoogle.set(entry.google.sub, entry.user.id);
        break;
      case "googleLinked": {
        const before = this.googleOfUser.get(entry.userId);
        if (before !== undefined) this.userOfGoogle.delete(before.sub);
        this.googleOfUser.set(entry.userId, { sub: entry.google.sub });
        this.userOfGoogle.set(entry.google.sub, entry.userId);
        break;
      }
      case "googleUnlinked":
        this.unlinkGoogleOf(entry.userId);
        break;
      case "accountDeleted": {
        const { userId } = entry;
        const user = this.users.get(userId);
        if (user !== undefined) user.name = DELETED_NAME;
        for (const p of this.passkeysOf(userId)) this.passkeys.delete(p.id);
        this.unlinkGoogleOf(userId);
        this.recoveryHashes.delete(userId);
        this.profiles.delete(userId);
        this.sessionVersions.set(userId, this.sessionVersion(userId) + 1);
        this.sessions.delete(userId);
        for (const [id, c] of this.communityById) {
          if (c.createdBy === userId) this.communityById.set(id, { ...c, createdBy: "" });
        }
        this.deletedUsers.add(userId);
        break;
      }
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
  return new Date(Date.now()).toISOString();
}

// The accounts an entry is by or about.
function accountsOf(entry: Entry): string[] {
  switch (entry.type) {
    case "action":
    case "poll":
    case "pollVote":
      return [entry.by];
    case "community":
      return [entry.community.createdBy];
    case "invite":
      return [entry.invite.by];
    case "passkey":
    case "googleAccount":
      return [entry.user.id];
    case "passkeyAdded":
      return [entry.passkey.userId];
    case "commonsMoved":
      return [entry.commonsFounder];
    default:
      return "userId" in entry ? [entry.userId] : [];
  }
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
