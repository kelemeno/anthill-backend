// "Download my data": everything Anthill holds about one account, as JSON.
// That's the account and how it signs in, its profile and open sessions, its
// passkeys (what they are, never their keys), its place and reputation in
// each community, and every log entry it wrote or that is about it: tree
// actions (its own, and others' endorsements and moves that name it), polls,
// votes (each with its poll's question, options and community, and the
// result once it closed: what members see anyway), invites, sign-ins,
// renames, the community sites it saved. Secrets stay out (passkeys' public
// keys, the recovery code's hash), and so does anything that is only about
// other people. The Google email isn't in the log (see store.ts): it comes
// from the side file, with the linked Google account.

import type { LogEntry, Poll, Store } from "./store";

// Where the account stands in one community (see offchainApi.ts).
export type Standing = {
  id: string;
  name: string;
  // the node it's under, null for the root, undefined when not in the tree
  parent?: string | null;
  reputation?: string;
  founder: boolean;
};

// The entry as exported, or undefined when it isn't about `userId`. `mine`
// collects what later entries are about (its passkeys, polls it made or
// voted in, communities). `pollOf` finds a poll (a vote comes after its poll
// in the log, so the poll's entry has been passed by then).
function aboutUser(
  entry: LogEntry,
  userId: string,
  mine: Set<string>,
  pollOf: (id: string) => { poll: Poll; community: string } | undefined,
): unknown {
  // a passkey without its public key (or counter: that's the authenticator's)
  const passkeyInfo = (p: { id: string; transports?: string[] }) => ({ id: p.id, transports: p.transports });
  switch (entry.type) {
    case "seed": {
      // the original tree: just the account's own node
      const node = Object.values(entry.graph.dict).find((n) => n.id.toLowerCase() === userId);
      return node === undefined ? undefined : { type: entry.type, at: entry.at, node };
    }
    case "community":
      if (entry.community.createdBy !== userId) return undefined;
      mine.add(`community:${entry.community.id}`);
      return entry;
    case "communityUpdate":
      return mine.has(`community:${entry.id}`) ? entry : undefined;
    case "communitySite":
      return entry.by === userId ? entry : undefined;
    case "commonsMoved":
      if (entry.commonsFounder !== userId) return undefined;
      mine.add("community:commons");
      return { type: entry.type, at: entry.at, commonsFounder: entry.commonsFounder };
    case "passkey":
    case "passkeyAdded": {
      const userOf = entry.type === "passkey" ? entry.user.id : entry.passkey.userId;
      if (userOf !== userId) return undefined;
      mine.add(`passkey:${entry.passkey.id}`);
      return { ...entry, passkey: passkeyInfo(entry.passkey) };
    }
    case "counter":
      return mine.has(`passkey:${entry.id}`) ? entry : undefined;
    case "recovery":
      // that a recovery code was made, not its hash
      return entry.userId === userId ? { type: entry.type, at: entry.at } : undefined;
    case "recovered":
      if (entry.userId !== userId) return undefined;
      mine.add(`passkey:${entry.passkey.id}`);
      return { type: entry.type, at: entry.at, passkey: passkeyInfo(entry.passkey) };
    case "googleAccount":
      return entry.user.id === userId ? entry : undefined;
    case "signOutAll":
    case "name":
    case "profile":
    case "session":
    case "sessionEnd":
    case "passkeyRemoved":
    case "googleLinked":
    case "googleUnlinked":
      return entry.userId === userId ? entry : undefined;
    case "invite":
      return entry.invite.by === userId ? entry : undefined;
    case "poll":
      if (entry.by !== userId) return undefined;
      mine.add(`poll:${entry.id}`);
      return entry;
    case "pollVote": {
      if (entry.by !== userId) return undefined;
      // the poll's id alone says nothing: what it asked, where (not who asked)
      mine.add(`poll:${entry.pollId}`);
      const found = pollOf(entry.pollId);
      if (found === undefined) return entry;
      const { poll, community } = found;
      return { ...entry, poll: { community, question: poll.question, options: poll.options } };
    }
    case "pollClose":
      return mine.has(`poll:${entry.pollId}`) ? entry : undefined;
    case "action": {
      const recipient = (entry.action.args as { recipient?: string }).recipient;
      return entry.by === userId || recipient === userId ? entry : undefined;
    }
    case "migration":
    case "accountDeleted":
      return undefined;
  }
}

export async function accountExport(store: Store, userId: string, communities: Standing[]) {
  const user = store.user(userId)!;
  const google = store.googleOf(userId);
  const mine = new Set<string>();
  const log: unknown[] = [];
  for await (const entry of store.entries()) {
    const exported = aboutUser(entry, userId, mine, (id) => {
      const poll = store.poll(id);
      return poll === undefined ? undefined : { poll, community: store.communityOf(poll) };
    });
    if (exported !== undefined) log.push(exported);
  }
  const body = {
    about:
      "Everything Anthill holds about your account. The log is Anthill's history: entries stay in it even after a change or a deletion.",
    exportedAt: new Date(Date.now()).toISOString(),
    account: {
      id: user.id,
      name: user.name,
      signInMethods: {
        passkeys: store.passkeysOf(userId).length,
        google: google === undefined ? null : { sub: google.sub, email: google.email ?? null },
        recoveryCode: store.recoveryHashOf(userId) !== undefined,
      },
    },
    profile: store.profile(userId) ?? { bio: "", link: "" },
    sessions: store.sessionsOf(userId).map(({ sid, method, device, at, expires }) => ({
      id: sid,
      method,
      device,
      createdAt: at,
      expires,
    })),
    passkeys: store.passkeysOf(userId).map((p) => {
      const { addedAt, usedAt } = store.passkeyDates(p.id);
      return { id: p.id, createdAt: addedAt, lastUsedAt: usedAt, transports: p.transports ?? [] };
    }),
    communities,
    log,
  };
  // bigints (vote weights in the seed) as decimal strings
  return JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2);
}
