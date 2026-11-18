// The off-chain server's routes: sign-in (passkeys, Google), accounts, communities and,
// inside each community (/c/<id>/...), its tree, actions, invites and polls.
// The original unscoped paths (/graph, /action, ...) still answer for the
// default community, so pages loaded before communities existed keep working.
//
// Private communities answer 404 to anyone who isn't a member, as if they
// didn't exist; the only way in is an invite. Their ids share one namespace
// with public ones, though: starting a community at a taken private id says
// it's taken. That's accepted (it shows only that the address exists, nothing
// in it, and probing is rate limited); pick an unguessable address if even
// that matters.
//
// The WebSocket says "update:<key>" after a change in a community: the key is
// the id of a public one, and an opaque key for a private one (in its /graph
// response as `updateKey`, so only its members can tell). A bare "update"
// means anything may have changed (on startup).

import type { NonSharedBuffer } from "node:buffer";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createGzip, gunzip } from "node:zlib";
import type { Context, Hono } from "hono";
import { accountExport, type Standing } from "./account";
import type { AnthillContractType } from "./anthillContract";
import { AuthError, deviceLabel, PasskeyAuth } from "./auth";
import { CommonsSigner, isCommonsPublicKey } from "./commonsLink";
import { address0, address1, type GraphData } from "./dagBase";
import { type History, type HistoryNode, type HistoryStep, snapshotNodes } from "./dagHistory";
import { loadAnthillGraph } from "./dagLoading";
import {
  calculateDepthAndRelRoot,
  calculateReputation,
  findRandomLeaf,
} from "./dagProcessing";
import type { AnthillEngine, EngineEvent, SeedGraph } from "./engine";
import { playDemoStory } from "./demoStory";
import { type GoogleFlowAccount, type GoogleOptions, GoogleSignIn } from "./google";
import {
  clientIp,
  jsonBody,
  NotFoundError,
  RateLimitError,
  rateCount,
  rateLimit,
  rateRoom,
  requireAdmin,
} from "./http";
import { NodeDataStoreCollapse, type NodeDataString } from "./nodeData";
import { ActionError, Communities, cleanName, type Executed, type OffchainTree, parseName } from "./offchain";
import { Polls, setProfile } from "./social";
import {
  type ActionEntry,
  bigintReviver,
  DEFAULT_COMMUNITY,
  Store,
  type StoredUser,
} from "./store";

type Snapshot = { graph: SeedGraph; history: History; randomLeaf: string };

// The seeded tree (the original Anthill one) is a demo; the commons is for
// real members, and starts empty. Its founder starts its tree: by default
// Kalman's account, the only real person in the original tree when it moved
// (production's log already has the move, so this only matters for a new data
// dir). COMMONS_FOUNDER names another account; a founder without an account
// here (a fresh dev or staging data dir) would lock the commons for good, so
// then it has none and anyone can start it.
const DEMO = {
  id: "demo",
  name: "Anthill Demo",
  description:
    "The original Anthill tree, kept to show how it works: look around as any member to see where their reputation comes from.",
  visibility: "public",
  joinPolicy: "invite",
  createdBy: "",
} as const;
const COMMONS_FOUNDER = process.env.COMMONS_FOUNDER || "0xa0d64a92e36a7c122b28bd2e4b60b96aa8bd6c3d";
const gunzipAsync = promisify(gunzip);
// actions per /check request
const MAX_CHECKS = 5;
// new accounts per client IP and hour
const SIGNUPS_PER_HOUR = 100;
// tree actions per account and day
const ACTIONS_PER_DAY = 500;
// marks that the demo's story (demoStory.ts) has been played
const DEMO_STORY = "demo-story-1";
// account exports per account and hour, and per client IP and hour (each
// reads the whole log, and accounts cost nothing to make)
const EXPORTS_PER_HOUR = 5;
const EXPORTS_PER_IP_PER_HOUR = 10;
// exports run one at a time; more than this many waiting or running are
// refused, so the work they take is bounded however many accounts ask
const MAX_PENDING_EXPORTS = 3;
// account routes that need the trees loaded (the rest of /auth/ doesn't)
const AUTH_NEEDS_TREES = new Set(["/auth/export", "/auth/delete"]);

const BENEDEK = "0xc689334412b0666069b309dfd658f56b95dbaf5d";

// Joins `who` to a tree at its first free spot from the top, with an admin
// invite (whatever its join policy). False if nobody has started it yet.
function joinAtTop(tree: OffchainTree, who: string, name: string): boolean {
  const root = tree.engine.root();
  if (!tree.engine.isInTree(root)) return false;
  const queue = [root];
  while (tree.engine.children(queue[0]).length >= 2) {
    queue.push(...tree.engine.children(queue.shift()!));
  }
  const at = queue[0];
  // a dry run first, so a failure leaves nothing behind (not even the invite)
  tree.engine.simulate((e) => e.joinTree(who, name, at));
  const invite = tree.createAdminInvite(at).code;
  tree.execute(who, { fn: "joinTree", args: { name, invite } });
  return true;
}

// One-time fixes to the live data, run in order on startup after the demo's
// story. They get the loaded trees (a scratch copy; their actions go to the
// log and the load replays them). A fix returns whether it's done: it's then
// marked in the log and never runs again. Until then (not possible yet, or it
// threw) it runs again on the next start, so it must pick up where it stopped
// and check what it needs before it changes anything.
const FIXES: { id: string; run: (communities: Communities, store: Store) => boolean }[] = [
  {
    // The demo is for looking around: nobody joins it (not even by invite).
    id: "close-demo",
    run: (_communities, store) => {
      const demo = store.community(DEMO.id);
      if (demo === undefined) return true;
      const { name, description, visibility } = demo;
      store.updateCommunity(DEMO.id, { name, description, visibility, joinPolicy: "closed" });
      return true;
    },
  },
  {
    // Benedek joined the demo by mistake (through an invite from it): move him
    // to the commons, at its first free spot from the top. He joins the commons
    // first (with an admin invite, whatever its join policy), then leaves the
    // demo, so he's never in neither.
    id: "benedek-to-commons",
    run: (communities, store) => {
      const demo = communities.get(DEMO.id);
      const commons = communities.get(DEFAULT_COMMUNITY);
      if (demo === undefined || commons === undefined || !demo.engine.isInTree(BENEDEK)) return true;
      const name = store.user(BENEDEK)?.name || "Benedek";
      if (!commons.engine.isInTree(BENEDEK) && !joinAtTop(commons, BENEDEK, name)) return false;
      demo.execute(BENEDEK, { fn: "leaveTree" });
      return true;
    },
  },
  {
    // The first version of the fix above left the demo first and was marked
    // done even when the commons hadn't been started yet, leaving him in
    // neither. Then he joins the commons now (once it's started), unless he
    // was ever in it (and left on his own).
    id: "benedek-to-commons-2",
    run: (communities, store) => {
      const demo = communities.get(DEMO.id);
      const commons = communities.get(DEFAULT_COMMUNITY);
      if (
        demo === undefined ||
        commons === undefined ||
        demo.engine.isInTree(BENEDEK) ||
        commons.engine.isInTree(BENEDEK) ||
        store.joinedAt(DEFAULT_COMMUNITY, BENEDEK) !== undefined ||
        store.joinedAt(DEMO.id, BENEDEK) === undefined
      ) {
        return true;
      }
      return joinAtTop(commons, BENEDEK, store.user(BENEDEK)?.name || "Benedek");
    },
  },
  {
    // Closed communities (the demo) were logged as joinPolicy "closed", which
    // code from before it treats as open: log them again in the form a
    // rollback reads as invite only (see store.ts toStored). Same settings.
    id: "closed-rollback-safe",
    run: (_communities, store) => {
      for (const { id, name, description, visibility, joinPolicy } of store.communities()) {
        if (joinPolicy === "closed") store.updateCommunity(id, { name, description, visibility, joinPolicy });
      }
      return true;
    },
  },
];

// Whether a node looks the same in two history steps.
function sameNode(a: HistoryNode, b: HistoryNode) {
  const sameIds = (x: string[], y: string[]) => x.length === y.length && x.every((id, i) => id === y[i]);
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.currentRep === b.currentRep &&
    a.depth === b.depth &&
    a.sentTreeVote === b.sentTreeVote &&
    sameIds(a.recTreeVotes, b.recTreeVotes) &&
    sameIds(a.dagVotes, b.dagVotes)
  );
}

// What's served for one community, rebuilt after every action.
class TreeView {
  graph: GraphData = { rootId: address0, maxRelRootDepth: 6, dict: {} };
  version = 0;
  randomLeaf = address0;
  history: History = { steps: [] };
  // the served history, serialized and gzipped once per step
  private historyGzip: { steps: number; body: Promise<NonSharedBuffer> } | undefined;

  // Recompute from the engine. The engine answers the same reads as the
  // contract, so this reuses the chain loader.
  async rebuild(engine: AnthillEngine) {
    const graph: GraphData = { rootId: address0, maxRelRootDepth: 6, dict: {} };
    if (engine.root() !== address0) {
      await loadAnthillGraph(graph, [[]], 0, engine as unknown as AnthillContractType, true);
      const byDepth = [[]] as string[][];
      calculateDepthAndRelRoot(graph, byDepth);
      calculateReputation(graph, byDepth);
    }
    this.randomLeaf = graph.rootId === address0 ? address0 : findRandomLeaf(graph);
    this.graph = graph;
    this.version += 1;
  }

  // Each step has every node, as the replay needs; a node that didn't change
  // is the previous step's object, so a step mostly costs its list.
  pushStep(entry: ActionEntry, events: EngineEvent[]) {
    const args = entry.action.args as Record<string, string | undefined>;
    const index = this.history.steps.length;
    const previous = new Map(this.history.steps[index - 1]?.nodes.map((n) => [n.id, n]));
    const nodes = snapshotNodes(this.graph).map((node) => {
      const before = previous.get(node.id);
      return before !== undefined && sameNode(before, node) ? before : node;
    });
    this.history.steps.push({
      index,
      eventName: events[events.length - 1]?.eventName ?? entry.action.fn,
      voter: entry.by,
      recipient: args.recipient ?? "",
      name: args.name ?? "",
      weight: args.weight ?? "0",
      blockNumber: index,
      nodes,
    });
  }

  // Made at most once per step and one at a time per community (each waits
  // for the one before), since a long history takes a while.
  historyBody(): Promise<NonSharedBuffer> {
    const steps = this.history.steps.length;
    if (this.historyGzip?.steps !== steps) {
      const before = this.historyGzip?.body.catch(() => undefined);
      const list = this.history.steps.slice();
      const body = Promise.resolve(before).then(() => gzipHistory(list));
      this.historyGzip = { steps, body };
      // a failed one is made again on the next request
      body.catch(() => {
        if (this.historyGzip?.body === body) this.historyGzip = undefined;
      });
    }
    return this.historyGzip.body;
  }
}

// steps serialized between pauses
const HISTORY_BATCH = 50;

// The history as JSON ({ steps }), gzipped a batch of steps at a time: a long
// one never blocks the server for long, nor is it ever one string (V8 caps a
// string at about 512 MB).
async function gzipHistory(steps: HistoryStep[]): Promise<NonSharedBuffer> {
  const gzip = createGzip();
  const chunks: Buffer[] = [];
  gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<void>((resolve, reject) => {
    gzip.on("end", resolve);
    gzip.on("error", reject);
  });
  const write = (text: string) =>
    new Promise<void>((resolve) => (gzip.write(text) ? resolve() : gzip.once("drain", resolve)));
  await write('{"steps":[');
  for (let i = 0; i < steps.length; i += HISTORY_BATCH) {
    const batch = steps.slice(i, i + HISTORY_BATCH).map((step) => JSON.stringify(step));
    await write((i === 0 ? "" : ",") + batch.join(","));
    // let requests in between
    await new Promise((resolve) => setImmediate(resolve));
  }
  gzip.end("]}");
  await ended;
  return Buffer.concat(chunks);
}

// Paths that also answer, unscoped, for the default community.
const LEGACY_PATHS = new Set([
  "/graph",
  "/history",
  "/action",
  "/check",
  "/people/:id/reach",
  "/invites",
  "/polls",
  "/polls/:id/vote",
  "/polls/:id/close",
]);

// Registers the routes (they must exist before the first request) and returns
// start(), which rebuilds everything from the log. `options.google` replaces
// Google's endpoints and config (for the checks).
export function offchainServer(
  app: Hono,
  broadcast: (message: string) => void,
  options: { google?: GoogleOptions } = {},
) {
  const dataDir = process.env.DATA_DIR || join(process.cwd(), "data");
  const snapshotPath = join(process.cwd(), "anthillSnapshot.json");
  const readSnapshot = () =>
    JSON.parse(readFileSync(snapshotPath, "utf8"), bigintReviver) as Snapshot;

  const store = new Store(dataDir);
  console.log("Off-chain mode, data in", dataDir);
  if (store.seed === undefined && store.actions.length === 0 && process.env.SEED !== "empty") {
    console.log("Seeding a new tree from", snapshotPath);
    store.setSeed(readSnapshot().graph);
  }
  if (store.seed !== undefined && store.originalCommunity === DEFAULT_COMMUNITY) {
    console.log("Moving the seeded tree to the demo community; the commons starts empty");
    const founder = store.user(COMMONS_FOUNDER) !== undefined ? COMMONS_FOUNDER : "";
    if (founder === "") {
      console.log(`No account ${COMMONS_FOUNDER} (COMMONS_FOUNDER): anyone can start the commons`);
    }
    store.moveCommons({ ...DEMO, createdAt: new Date().toISOString() }, founder);
  }

  // Until start() has rebuilt everything from the log, the trees hold only part
  // of it: an action taken then would be checked against the wrong state, and
  // pages would see (and cache) a half-built tree. So everything but signing in
  // (and the WebSocket) waits.
  let ready = false;
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (!ready && path !== "/" && (!path.startsWith("/auth/") || AUTH_NEEDS_TREES.has(path))) {
      c.header("Retry-After", "5");
      return c.json({ error: "Starting up, try again in a moment." }, 503);
    }
    await next();
  });

  const auth = new PasskeyAuth(store);
  // seals Google sign-in flows, and makes private communities' update keys
  const keySecret = process.env.SESSION_SECRET || store.sessionSecret(() => randomBytes(32).toString("hex"));
  const google = new GoogleSignIn(keySecret, options.google);
  const commonsSigner = new CommonsSigner(dataDir);
  const communities = new Communities(store);
  const views = new Map<string, TreeView>();
  const polls = new Map<string, Polls>();

  const viewOf = (tree: OffchainTree) => {
    let view = views.get(tree.id);
    if (view === undefined) {
      view = new TreeView();
      views.set(tree.id, view);
    }
    return view;
  };

  const pollsOf = (tree: OffchainTree) => {
    let p = polls.get(tree.id);
    if (p === undefined) {
      p = new Polls(
        store,
        tree.id,
        (id) => tree.isMember(id),
        (id) => viewOf(tree).graph.dict[id]?.currentRep ?? 0n,
        () => tree.info.createdBy || tree.engine.root(),
      );
      polls.set(tree.id, p);
    }
    return p;
  };

  // The seeded tree's history continues the snapshot's, which leads up to the
  // seeded state.
  if (store.seed !== undefined) {
    viewOf(communities.get(store.originalCommunity)!).history = readSnapshot().history;
  }

  async function record({ tree, entry, events }: Executed) {
    const view = viewOf(tree);
    await view.rebuild(tree.engine);
    view.pushStep(entry, events);
  }

  // What the WebSocket calls a community (see the top): private ones' ids
  // aren't broadcast. The key can't be an id ("_" isn't allowed in one).
  function updateKeyOf(tree: OffchainTree) {
    if (tree.info.visibility === "public") return tree.id;
    return `p_${createHmac("sha256", keySecret).update(`update-key:${tree.id}`).digest("hex").slice(0, 24)}`;
  }

  // Tell open pages of these communities to reload (also under `before`, the
  // key from before a change of visibility).
  function notify(trees: OffchainTree[], before?: string) {
    const keys = new Set(trees.map(updateKeyOf));
    if (before !== undefined) keys.add(before);
    for (const key of keys) broadcast(`update:${key}`);
  }

  // Rename the account everywhere (POST /name, or changeName as an action),
  // and tell the communities whose node changed.
  async function rename(user: StoredUser, body: unknown) {
    rateLimit(`name:${user.id}`, 10);
    let renamed: Executed[] = [];
    await serially(async () => {
      renamed = communities.rename(user, body);
      for (const executed of renamed) await record(executed);
    });
    notify(renamed.map((executed) => executed.tree));
  }

  // Actions are handled one at a time so each history step shows the graph
  // right after its own action.
  let queue: Promise<void> = Promise.resolve();
  function serially(fn: () => Promise<void>): Promise<void> {
    const result = queue.then(fn);
    queue = result.catch(() => undefined);
    return result;
  }

  const signedIn = (c: Context) => auth.userFromHeader(c.req.header("Authorization"));
  const freshUser = (c: Context) => auth.freshUserFromHeader(c.req.header("Authorization"));
  // what a new session is labelled in the account's session list
  const deviceOf = (c: Context) => deviceLabel(c.req.header("User-Agent"));

  // The body of a passkey ceremony's second step, checked before the flow is
  // used up, so a malformed one is a 400 and the flow can still be finished.
  async function ceremony(c: Context) {
    const { flowId, response } = await jsonBody(c);
    if (
      typeof flowId !== "string" ||
      typeof response !== "object" ||
      response === null ||
      typeof response.id !== "string"
    ) {
      throw new ActionError("expected a flowId and a passkey response");
    }
    return { flowId, response };
  }

  const viewerOf = (c: Context) => {
    try {
      return signedIn(c).id;
    } catch {
      return undefined;
    }
  };

  const param = (c: Context, name: string) => c.req.param(name) ?? "";
  const cidOf = (c: Context) => c.req.param("cid") ?? DEFAULT_COMMUNITY;

  function visibleTree(c: Context, viewer: string | undefined) {
    const tree = communities.get(cidOf(c));
    if (tree === undefined || !tree.visibleTo(viewer)) throw new NotFoundError();
    return tree;
  }

  function summary(tree: OffchainTree, viewer?: string) {
    const { id, name, description, visibility, joinPolicy, createdBy, createdAt } = tree.info;
    const steward = createdBy || tree.engine.root();
    const { dict, rootId } = viewOf(tree).graph;
    // as served: not whoever the root doesn't reach (see isMember)
    const members = tree.engine.members().filter((m) => tree.isMember(m));
    const me = viewer !== undefined && tree.isMember(viewer) ? dict[viewer] : undefined;
    return {
      id,
      name,
      description,
      visibility,
      joinPolicy,
      createdAt,
      founder: createdBy === "" ? null : { id: createdBy, name: store.user(createdBy)?.name ?? "" },
      members: members.length,
      rootName: dict[rootId]?.name ?? "",
      isFounder: viewer !== undefined && viewer === createdBy,
      // the founder, or the tree's root when there's none (see updateSettings)
      canChangeSettings: viewer !== undefined && viewer === steward,
      // the viewer's standing, when they're a member
      you:
        me === undefined
          ? null
          : {
              reputation: me.currentRep.toString(),
              rank: 1 + members.filter((m) => (dict[m]?.currentRep ?? 0n) > me.currentRep).length,
            },
    };
  }

  // A route inside a community, also registered unscoped for the default one
  // when it's a legacy path.
  function route(
    method: "GET" | "POST",
    path: string,
    handler: (c: Context) => Response | Promise<Response>,
  ) {
    const paths = [`/c/:cid${path}`];
    if (LEGACY_PATHS.has(path)) paths.push(path);
    app.on(method, paths, handler);
  }

  ////////////////////////////////////////////
  //// passkey sign-in and accounts

  // Which ways to sign in this server offers (Google only when configured).
  app.get("/auth/methods", (c) => c.json({ passkey: true, google: google.enabled }));

  app.post("/auth/register/options", async (c) => {
    const { name } = await jsonBody(c);
    return c.json(await auth.registrationOptions(parseName(name)));
  });

  // New accounts per IP and hour (only ones made: a failed try doesn't count),
  // with room for a meetup on one Wi-Fi. Passkeys cost nothing to make in
  // software, so this only slows scripted sign-ups down (the IP isn't
  // trustworthy either); invite-only communities are the real guard against
  // fake members.
  app.post("/auth/register/verify", async (c) => {
    const { flowId, response } = await ceremony(c);
    const key = `signup:${clientIp(c)}`;
    rateRoom(key, SIGNUPS_PER_HOUR);
    const created = await auth.verifyRegistration(flowId, response, deviceOf(c));
    rateCount(key, 60 * 60_000);
    return c.json(created);
  });

  app.post("/auth/login/options", async (c) => {
    return c.json(await auth.authenticationOptions());
  });

  app.post("/auth/login/verify", async (c) => {
    const { flowId, response } = await ceremony(c);
    return c.json(await auth.verifyAuthentication(flowId, response, deviceOf(c)));
  });

  // `methods` (how the account signs in) is for the account page.
  app.get("/auth/me", (c) => {
    const user = signedIn(c);
    return c.json({
      user,
      profile: store.profile(user.id) ?? { bio: "", link: "" },
      methods: auth.methods(user),
    });
  });

  // The account's passkeys: when each was added and last signed in.
  app.get("/auth/passkeys", (c) => c.json({ passkeys: auth.passkeys(signedIn(c)) }));

  // Needs a recent sign-in; refused for the account's last way to sign in.
  // Ends the sessions made with the passkey, but the caller's.
  app.post("/auth/passkeys/:id/remove", (c) =>
    c.json(auth.removePasskey(c.req.header("Authorization"), param(c, "id"))),
  );

  // Another passkey (device) for the signed-in account. Needs a recent
  // sign-in; the flow then ends with the session (e.g. after sign-out
  // everywhere, checked again when the passkey is added).
  app.post("/auth/passkeys/options", async (c) => {
    return c.json(await auth.addPasskeyOptions(freshUser(c)));
  });

  app.post("/auth/passkeys/verify", async (c) => {
    signedIn(c);
    const { flowId, response } = await ceremony(c);
    return c.json(await auth.verifyAddPasskey(c.req.header("Authorization"), flowId, response));
  });

  // Lost every passkey: register a new one with the recovery code.
  app.post("/auth/recover/options", async (c) => {
    rateLimit(`recover:${clientIp(c)}`, 10);
    const { code } = await jsonBody(c);
    if (typeof code !== "string") throw new ActionError("Enter your recovery code.");
    return c.json(await auth.recoveryOptions(code));
  });

  app.post("/auth/recover/verify", async (c) => {
    const { flowId, response } = await ceremony(c);
    return c.json(await auth.verifyRecovery(flowId, response, deviceOf(c)));
  });

  // Needs a recent sign-in: whoever holds only a copied token can't take the
  // account's recovery over.
  app.post("/auth/recovery-code", (c) => {
    return c.json({ recoveryCode: auth.newRecoveryCode(freshUser(c)) });
  });

  // Ends every session of the account, this one too (a lost device, a shared
  // computer). The passkeys stay.
  app.post("/auth/sign-out-everywhere", (c) => {
    return c.json(auth.signOutEverywhere(signedIn(c)));
  });

  // The account's open sessions (devices signed in), the caller's marked.
  app.get("/auth/sessions", (c) => c.json({ sessions: auth.sessions(c.req.header("Authorization")) }));

  // End one of your sessions (no recent sign-in needed: it only protects).
  app.post("/auth/sessions/:id/end", (c) => c.json(auth.endSession(signedIn(c), param(c, "id"))));

  // Ends this session on the server; the page forgets the token either way.
  app.post("/auth/sign-out", (c) => c.json(auth.signOut(c.req.header("Authorization"))));

  ////////////////////////////////////////////
  //// Google sign-in (see google.ts)

  // Starts a flow and answers the Google page to send the person to. Linking
  // a Google account to yours needs a recent sign-in, and the flow is bound
  // to your account. So is confirming it's you ("confirm", for an account
  // that signs in only with Google, whose sign-in isn't recent: that's why it
  // confirms), which needs a linked Google account.
  app.post("/auth/google/start", async (c) => {
    const { intent, origin } = await jsonBody(c);
    let account: GoogleFlowAccount | undefined;
    if (intent === "link") account = { user: freshUser(c).id };
    if (intent === "confirm") {
      const { user, sid } = auth.currentSession(c.req.header("Authorization"));
      const linked = store.googleOf(user.id);
      if (linked === undefined) throw new ActionError("No Google account is linked to yours.");
      account = { user: user.id, sid, loginHint: linked.email || undefined };
    }
    const { url } = google.start(intent, origin, account);
    return c.json({ url });
  });

  // The page Google sent the person back to hands us the code. A sign-in
  // answers a session (a new account counts against the sign-up limit, like
  // a passkey's); a link answers the linked email; a confirm answers a fresh
  // session if it was the linked Google account, and never makes an account.
  // Link and confirm need the account that started them still signed in.
  app.post("/auth/google/finish", async (c) => {
    const { state, code } = await jsonBody(c);
    const done = await google.finish(state, code);
    if (done.intent === "link") {
      const user = signedIn(c);
      if (user.id !== done.user) throw new AuthError("This Google link was started for another account.");
      return c.json(auth.linkGoogle(user, done.identity));
    }
    if (done.intent === "confirm") {
      const user = signedIn(c);
      if (user.id !== done.user) throw new AuthError("This confirmation was started for another account.");
      return c.json(auth.confirmWithGoogle(user, done.sid, done.identity, deviceOf(c)));
    }
    const key = `signup:${clientIp(c)}`;
    const signedInWithGoogle = auth.googleSignIn(done.identity, deviceOf(c), () => rateRoom(key, SIGNUPS_PER_HOUR));
    if (signedInWithGoogle.created) rateCount(key, 60 * 60_000);
    return c.json(signedInWithGoogle);
  });

  // Needs a recent sign-in, and a passkey to sign in with afterwards. Ends
  // the sessions made with Google, but the caller's.
  app.post("/auth/google/unlink", (c) => c.json(auth.unlinkGoogle(c.req.header("Authorization"))));

  ////////////////////////////////////////////
  //// export and delete your account

  // Everything Anthill holds about the account, as a JSON download (see
  // account.ts). Each reads the whole log, so they're limited per account
  // and per IP, and run one at a time (see MAX_PENDING_EXPORTS).
  let exportQueue: Promise<unknown> = Promise.resolve();
  let pendingExports = 0;
  app.get("/auth/export", async (c) => {
    const user = signedIn(c);
    rateLimit(`export:${user.id}`, EXPORTS_PER_HOUR, 60 * 60_000);
    rateLimit(`export-ip:${clientIp(c)}`, EXPORTS_PER_IP_PER_HOUR, 60 * 60_000);
    if (pendingExports >= MAX_PENDING_EXPORTS) throw new RateLimitError(Date.now() + 10_000);
    pendingExports += 1;
    const run = exportQueue.then(() => {
      // still signed in once it's this one's turn (not deleted meanwhile)
      signedIn(c);
      const standings: Standing[] = communities
        .all()
        .filter((tree) => tree.engine.isInTree(user.id) || tree.info.createdBy === user.id)
        .map((tree) => {
          const inTree = tree.engine.isInTree(user.id);
          const parent = tree.engine.parent(user.id);
          return {
            id: tree.id,
            name: tree.info.name,
            parent: inTree ? (parent === address1 ? null : parent) : undefined,
            reputation: inTree ? (viewOf(tree).graph.dict[user.id]?.currentRep ?? 0n).toString() : undefined,
            founder: tree.info.createdBy === user.id,
          };
        });
      return accountExport(store, user.id, standings);
    });
    exportQueue = run.catch(() => undefined);
    let body: string;
    try {
      body = await run;
    } finally {
      pendingExports -= 1;
    }
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="anthill-account-${user.id}.json"`);
    return c.body(body);
  });

  // Deletes the account, for good. Needs a recent sign-in and the account's
  // name typed out. It first leaves every community's tree with a normal
  // leaveTree action (in each history, and announced like any action). A
  // leaver's children move up as on any leave: the first child takes their
  // place, its branch rises, and the second child goes under it; a root's
  // first child becomes the root, and a root alone leaves the tree empty.
  // Then one log entry removes every way to sign in, the profile, the
  // recovery code and every session, renames the account "Deleted account",
  // and leaves the communities it founded without a founder (their root
  // changes their settings from then on; an empty public one can be started
  // by anyone, unless it's closed; an empty private one is seen by nobody, so
  // it stays empty). The id is never reused, and nothing more is written for
  // it (see store.ts). Past entries stay in the log: it's the history. The
  // Google email, kept outside the log, is erased; Google's id for the
  // account stays in the log.
  //
  // The name is compared as it shows (cleanName): names from before names
  // were cleaned may hold double spaces or invisible characters.
  app.post("/auth/delete", async (c) => {
    freshUser(c);
    const { confirm } = await jsonBody(c);
    const changed = new Set<OffchainTree>();
    await serially(async () => {
      // checked once it's this one's turn: the session may have ended (signed
      // out everywhere, or the account deleted) while it waited
      const user = freshUser(c);
      if (typeof confirm !== "string" || cleanName(confirm) === "" || cleanName(confirm) !== cleanName(user.name)) {
        throw new ActionError("To confirm, type your account name exactly as it's shown.");
      }
      for (const tree of communities.all()) {
        if (tree.info.createdBy === user.id) changed.add(tree);
        if (!tree.engine.isInTree(user.id)) continue;
        await record(tree.execute(user.id, { fn: "leaveTree" }));
        changed.add(tree);
      }
      store.deleteAccount(user.id);
    });
    notify([...changed]);
    return c.json({ ok: true });
  });

  // Rename the account, and its node in every community it's in.
  app.post("/name", async (c) => {
    const user = signedIn(c);
    await rename(user, await jsonBody(c));
    return c.json({ user: store.user(user.id) });
  });

  // Bio and link, shown in every community.
  app.post("/profile", async (c) => {
    const user = signedIn(c);
    rateLimit(`profile:${user.id}`, 10);
    const { profile, changed } = setProfile(store, user.id, await jsonBody(c));
    if (changed) notify(communities.all().filter((tree) => tree.isMember(user.id)));
    return c.json({ profile });
  });

  ////////////////////////////////////////////
  //// communities

  // Public communities and the private ones the viewer belongs to: the
  // commons first, then the biggest.
  app.get("/communities", (c) => {
    const viewer = viewerOf(c);
    const first = (id: string) => (id === DEFAULT_COMMUNITY ? 0 : 1);
    const list = communities
      .all()
      .filter((tree) => tree.visibleTo(viewer))
      .map((tree) => summary(tree, viewer))
      .sort((a, b) => first(a.id) - first(b.id) || b.members - a.members);
    return c.json({ communities: list });
  });

  app.post("/communities", async (c) => {
    const user = signedIn(c);
    rateLimit(`create:${user.id}`, 10);
    const body = await jsonBody(c);
    let created: Executed | undefined;
    await serially(async () => {
      created = communities.create(user, body);
      await record(created);
    });
    notify([created!.tree]);
    return c.json({ community: summary(created!.tree, user.id) });
  });

  app.get("/c/:cid", (c) => {
    const viewer = viewerOf(c);
    return c.json({ community: summary(visibleTree(c, viewer), viewer) });
  });

  // Founder only (the tree's root without one, see updateSettings): name,
  // description, visibility and join policy.
  app.post("/c/:cid/settings", async (c) => {
    const user = signedIn(c);
    const tree = visibleTree(c, user.id);
    const before = updateKeyOf(tree);
    if (communities.updateSettings(user.id, tree, await jsonBody(c))) notify([tree], before);
    return c.json({ community: summary(tree, user.id) });
  });

  ////////////////////////////////////////////
  //// inside a community

  // The whole served tree in one response. `version` changes on every update;
  // `updateKey` is what the WebSocket calls this community (see the top).
  route("GET", "/graph", (c) => {
    const viewer = viewerOf(c);
    const tree = visibleTree(c, viewer);
    const view = viewOf(tree);
    const nodes: { [id: string]: NodeDataString } = {};
    for (const [id, node] of Object.entries(view.graph.dict)) {
      nodes[id] = NodeDataStoreCollapse(node, store.profile(id));
    }
    return c.json({
      version: view.version,
      updateKey: updateKeyOf(tree),
      rootId: view.graph.rootId,
      maxRelRootDepth: view.graph.maxRelRootDepth,
      randomLeaf: view.randomLeaf,
      config: { inviteOnly: tree.info.joinPolicy !== "open" },
      community: summary(tree, viewer),
      nodes,
    });
  });

  // Every past step of the tree, each with a snapshot of all nodes. It's big
  // (it grows with steps times members), so it's sent gzipped, made once per
  // step, and limited per client.
  route("GET", "/history", async (c) => {
    rateLimit(`history:${clientIp(c)}`, 30);
    const body = await viewOf(visibleTree(c, viewerOf(c))).historyBody();
    c.header("Content-Type", "application/json");
    c.header("Vary", "Accept-Encoding");
    if (!/\bgzip\b/.test(c.req.header("Accept-Encoding") ?? "")) return c.body(await gunzipAsync(body));
    c.header("Content-Encoding", "gzip");
    return c.body(body);
  });

  // Run one tree action as the signed-in user.
  route("POST", "/action", async (c) => {
    const user = signedIn(c);
    rateLimit(`action:${user.id}`, 60);
    // each action is a history step with the whole tree: a day's cap keeps
    // one account toggling an endorsement from growing it without end
    rateLimit(`actions-day:${user.id}`, ACTIONS_PER_DAY, 24 * 60 * 60_000);
    const body = await jsonBody(c);
    const tree = communities.get(cidOf(c));
    // Outsiders of a private community can only join it, with its invite.
    const invite = (body as { fn?: unknown; args?: { invite?: unknown } } | null)?.args?.invite;
    const invited =
      body?.fn === "joinTree" &&
      typeof invite === "string" &&
      store.communityOf(store.invite(invite) ?? { community: "" }) === tree?.id;
    if (tree === undefined || !(tree.visibleTo(user.id) || invited)) {
      throw new NotFoundError();
    }
    // One name per account: renaming here renames it everywhere, as /name.
    if (body.fn === "changeName") {
      if (!tree.isMember(user.id)) throw new ActionError("Join the tree first.", "not in tree");
      await rename(user, body.args);
      return c.json({ ok: true });
    }
    await serially(async () => {
      await record(tree.execute(user.id, body));
    });
    notify([tree]);
    return c.json({ ok: true });
  });

  // Dry-run a few actions (a person's page asks about at most three): for
  // each, whether it would work and if not why. Each dry run blocks the server
  // for a copy of the whole tree, hence the small batch and the per-user limit.
  route("POST", "/check", async (c) => {
    const user = signedIn(c);
    rateLimit(`check:${user.id}`, 120);
    const tree = visibleTree(c, user.id);
    const { actions } = await jsonBody(c);
    if (!Array.isArray(actions) || actions.length > MAX_CHECKS) {
      throw new ActionError(`expected up to ${MAX_CHECKS} actions`);
    }
    return c.json({ results: tree.check(user.id, actions) });
  });

  // Who someone could endorse (give a reputation vote to) right now.
  route("GET", "/people/:id/reach", (c) => {
    const tree = visibleTree(c, viewerOf(c));
    return c.json({ canEndorse: tree.reach(param(c, "id").toLowerCase()) });
  });

  route("POST", "/invites", (c) => {
    const user = signedIn(c);
    const invite = visibleTree(c, user.id).createInvite(user.id);
    return c.json({ code: invite.code, expires: invite.expires });
  });

  route("GET", "/polls", (c) => {
    const viewer = viewerOf(c);
    return c.json({ polls: pollsOf(visibleTree(c, viewer)).listPolls(viewer) });
  });

  route("POST", "/polls", async (c) => {
    const user = signedIn(c);
    rateLimit(`polls:${user.id}`, 30);
    const tree = visibleTree(c, user.id);
    return c.json({ poll: pollsOf(tree).createPoll(user.id, await jsonBody(c)) });
  });

  route("POST", "/polls/:id/vote", async (c) => {
    const user = signedIn(c);
    rateLimit(`polls:${user.id}`, 30);
    const tree = visibleTree(c, user.id);
    return c.json({
      poll: pollsOf(tree).votePoll(user.id, param(c, "id"), await jsonBody(c)),
    });
  });

  route("POST", "/polls/:id/close", (c) => {
    const user = signedIn(c);
    rateLimit(`polls:${user.id}`, 30);
    const tree = visibleTree(c, user.id);
    return c.json({ poll: pollsOf(tree).closePoll(user.id, param(c, "id")) });
  });

  ////////////////////////////////////////////
  //// invite links (global: the code says which community)

  ////////////////////////////////////////////
  //// an agent commons linked to a community (see commonsLink.ts)

  // The key a commons records when it links to a community.
  app.get("/commons/key", (c) => c.json({ publicKey: commonsSigner.publicKey }));

  // The community's tree, signed, for the commons to pin. Who can see the
  // community can see its tree anyway (/graph), so the same rule applies.
  route("GET", "/commons/tree", (c) => {
    rateLimit(`commons-tree:${clientIp(c)}`, 60);
    const tree = visibleTree(c, viewerOf(c));
    return c.json(commonsSigner.tree(tree, viewOf(tree).history.steps.length, new Date().toISOString()));
  });

  // A member vouches for their commons key: Anthill signs that the key is
  // theirs, and the member hands the attestation to the commons, which admits
  // them as an owner under their Anthill id. Only current members get one.
  route("POST", "/commons/owner", async (c) => {
    const user = signedIn(c);
    rateLimit(`commons-owner:${user.id}`, 10);
    const tree = visibleTree(c, user.id);
    if (!tree.isMember(user.id)) throw new ActionError("only members of this community can join its commons");
    const { publicKey } = await jsonBody(c);
    if (!isCommonsPublicKey(publicKey)) throw new ActionError("publicKey must be an ed25519 public key (base64url SPKI DER)");
    return c.json(commonsSigner.owner(tree.id, user.id, publicKey, new Date().toISOString()));
  });

  app.get("/invites/:code", (c) => {
    const code = param(c, "code");
    const stored = store.invite(code);
    const tree = stored && communities.get(store.communityOf(stored));
    if (tree === undefined) throw new ActionError("This invite link isn't valid.");
    const invite = tree.validInvite(code);
    // Who holds the link sees what they need to decide: the community's name,
    // description and size, and who invited them. A private one's founder
    // and root stay for its members.
    const viewer = viewerOf(c);
    const community = summary(tree, viewer);
    return c.json({
      community: tree.visibleTo(viewer) ? community : { ...community, founder: null, rootName: "" },
      inviter: {
        id: invite.under,
        name: store.user(invite.under)?.name ?? viewOf(tree).graph.dict[invite.under]?.name ?? "",
      },
      expires: invite.expires,
    });
  });

  ////////////////////////////////////////////
  //// admin (ADMIN_TOKEN): log download for backups, invites for bootstrapping

  app.get("/admin/log", (c) => {
    requireAdmin(c);
    c.header("Content-Type", "application/x-ndjson");
    return c.body(readFileSync(store.logPath));
  });

  app.post("/admin/invites", async (c) => {
    requireAdmin(c);
    const { community, under } = await jsonBody(c);
    const tree = communities.get(typeof community === "string" ? community : DEFAULT_COMMUNITY);
    if (tree === undefined) throw new ActionError("no such community");
    const invite = tree.createAdminInvite(
      typeof under === "string" ? under.toLowerCase() : tree.engine.root(),
    );
    return c.json({ code: invite.code, expires: invite.expires });
  });

  return {
    async start() {
      // The demo's story (once), played on a scratch copy of the trees: its
      // actions go to the log, and the load below replays them with the rest.
      if (store.community(DEMO.id) !== undefined && !store.hasMigration(DEMO_STORY)) {
        // marked first: a crash halfway leaves part of the story, not two
        store.markMigration(DEMO_STORY);
        const scratch = new Communities(store);
        await scratch.load(async () => {});
        const demo = scratch.get(DEMO.id)!;
        const played = playDemoStory(
          demo,
          (under) => demo.createAdminInvite(under).code,
          (id) => store.user(id) !== undefined,
        );
        console.log("Played the demo's story:", played, "actions");
      }
      const pending = FIXES.filter((fix) => !store.hasMigration(fix.id));
      if (pending.length > 0) {
        const scratch = new Communities(store);
        await scratch.load(async () => {});
        for (const fix of pending) {
          try {
            if (fix.run(scratch, store)) {
              store.markMigration(fix.id);
              console.log("Applied fix", fix.id);
            } else {
              console.log("Fix", fix.id, "isn't possible yet, trying again on the next start");
            }
          } catch (e) {
            console.error("Fix failed", fix.id, "(trying again on the next start)", e);
          }
        }
      }
      await serially(() => communities.load(record));
      for (const tree of communities.all()) {
        await viewOf(tree).rebuild(tree.engine);
        // in the engine's tree but out of the root's reach (placed under its
        // scratch node before the API refused that): not shown, not members
        const detached = tree.detached();
        if (detached.length > 0) {
          console.warn(`Community ${tree.id}: ${detached.length} detached from the root:`, detached);
        }
      }
      ready = true;
      broadcast("update");
      console.log(
        "Loaded",
        communities.all().length,
        "communities,",
        store.actions.length,
        "actions; default tree has",
        communities.get(DEFAULT_COMMUNITY)!.engine.members().length,
        "members;",
        store.originalCommunity,
        "has",
        communities.get(store.originalCommunity)!.engine.members().length,
      );
    },
  };
}
