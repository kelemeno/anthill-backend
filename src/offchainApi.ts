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
// Communities with an agent commons (COMMONS_SITES) also have pairing
// routes for members' agents, their agents' list and revoke, and the agent
// instructions page (see commonsAgents.ts); others answer 404 there.
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
import {
  agentView,
  CommonsRelay,
  type CommonsSite,
  isHarness,
  isModelFamily,
  kitCommit,
  loopPrompt,
  type Pairing,
  pairingPrompt,
  Pairings,
  pairingView,
  parseCommonsSites,
  parseHarness,
  parseModelFamily,
  parseReason,
  renderAgentMd,
  SETTLE_MS,
} from "./commonsAgents";
import { CommonsSigner, isCommonsPublicKey, verifyPairProof } from "./commonsLink";
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
  optionalJsonBody,
  RateLimitError,
  RelayError,
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
// Google's endpoints and config, and `options.fetch` the requests to commons
// coordinators (for the checks).
export function offchainServer(
  app: Hono,
  broadcast: (message: string) => void,
  options: { google?: GoogleOptions; fetch?: typeof fetch } = {},
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
  // read now: a mistake in either stops the server here, not on a request
  const commonsSites = parseCommonsSites(process.env.COMMONS_SITES);
  const commonsKit = kitCommit();
  const pairings = new Pairings();
  const relay = new CommonsRelay(options.fetch);
  // This backend's public address, for the URLs agents are given: PUBLIC_URL,
  // else the one Render gives the service, else (developing locally) the
  // address the request came to.
  const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  if (publicUrl !== "" && !/^https?:\/\/[^/?#]+(\/[^?#]*)?$/.test(publicUrl)) throw new Error("PUBLIC_URL must be an http(s) URL");
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

  // (repo too, when the operator named it: the Agents page lists the hosts an
  // agent's sandbox must reach)
  function commonsOf(id: string): CommonsSite | undefined {
    const site = commonsSites.get(id);
    return site === undefined ? undefined : { coordinator: site.coordinator, site: site.site, ...(site.repo === undefined ? {} : { repo: site.repo }) };
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
      // where its agent commons is, when it has one
      commons: commonsOf(id) ?? null,
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
    // again once the body is in: the session may have ended meanwhile
    const asking = freshUser(c);
    const confirmed = (name: string) => typeof confirm === "string" && cleanName(confirm) !== "" && cleanName(confirm) === cleanName(name);
    if (!confirmed(asking.name)) throw new ActionError("To confirm, type your account name exactly as it's shown.");
    // its agents in every commons first (no write lock held while asking):
    // nothing is deleted unless that worked
    await revokeAllAgents(asking.id);
    const changed = new Set<OffchainTree>();
    await serially(async () => {
      // checked once it's this one's turn: the session may have ended (signed
      // out everywhere, or the account deleted) while it waited
      const user = freshUser(c);
      if (!confirmed(user.name)) throw new ActionError("To confirm, type your account name exactly as it's shown.");
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

  ////////////////////////////////////////////
  //// members' agents in the commons (see commonsAgents.ts)

  // The community's commons, or a 404: these routes exist only where the
  // operator configured one.
  function siteOf(tree: OffchainTree): CommonsSite {
    const site = commonsSites.get(tree.id);
    if (site === undefined) throw new NotFoundError();
    return site;
  }

  const backendOf = (c: Context) => publicUrl || new URL(c.req.url).origin;

  // For the agent's routes (no session): the community must exist and have
  // a commons. Its visibility isn't checked: the code is the secret, and a
  // wrong one learns nothing.
  function agentSide(c: Context) {
    const tree = communities.get(cidOf(c));
    if (tree === undefined) throw new NotFoundError();
    siteOf(tree);
    return tree;
  }

  const noPairing = () => new NotFoundError("No pairing has that code. Check it, or ask your owner for a new one.");

  // Agents pair only in a public community: the agent reads agent.md, and
  // the coordinator the community's tree, without an Anthill session, and a
  // private community shows neither to them (nor where its commons is).
  function publicOnly(tree: OffchainTree) {
    if (tree.info.visibility !== "public") {
      throw new ActionError("Agents can connect only to a public community's commons: this one is private.", "private community");
    }
  }

  // Signs and relays the revocation of one of `user`'s agents in `tree`'s
  // commons ("already" if the commons had it revoked).
  async function revokeAgent(site: CommonsSite, tree: OffchainTree, user: string, agentKey: string, reason: string) {
    const signed = commonsSigner.agentRevoke({ agentKey, at: new Date().toISOString(), community: tree.id, reason, user });
    try {
      return await relay.revokeAgent(site, signed);
    } finally {
      relay.forget(site, user);
    }
  }

  // Whether an approval whose answer was lost (p.attemptedAt) is in the
  // ledger: "active" when the coordinator lists the key as this member's,
  // active; "absent" when it doesn't (and the attempt was long enough ago
  // that it won't land now), or lists it revoked; "unsure" when that can't
  // be known now.
  async function lostApproval(site: CommonsSite, p: Pairing): Promise<"active" | "absent" | "unsure"> {
    const keyId = p.claim?.keyId;
    if (keyId === undefined || p.attemptedAt === undefined) return "absent";
    const since = p.attemptedAt;
    let known;
    try {
      known = (await relay.agentsOf(site, p.user, { fresh: true })).find((a) => a.keyId === keyId);
    } catch (e) {
      if (e instanceof RelayError || e instanceof ActionError || e instanceof RateLimitError) return "unsure";
      throw e;
    } finally {
      p.checkedAt = Date.now();
    }
    if (known?.active) return "active";
    if (known !== undefined) return "absent";
    return Date.now() > since + SETTLE_MS ? "absent" : "unsure";
  }

  // A pairing whose approval may have landed isn't expired by the clock
  // alone (Pairings.sweep): once its time is up, the coordinator decides. The
  // member did approve it, so it ends approved if the agent is there, and
  // expired if not; it stays as it is while that can't be known. Asked at
  // most every half minute, whoever polls.
  async function settleLost(site: CommonsSite, p: Pairing) {
    const now = Date.now();
    if (p.attemptedAt === undefined || p.relaying || p.status !== "claimed" || now <= p.expiresAt) return;
    if (p.checkedAt !== undefined && now < p.checkedAt + 30_000) return;
    p.relaying = true;
    try {
      const found = await lostApproval(site, p);
      if (found === "active") pairings.end(p, "approved");
      if (found === "absent") pairings.end(p, "expired");
    } finally {
      p.relaying = false;
    }
  }

  // The member's own pairing, or a 404.
  function myPairing(c: Context, user: string, tree: OffchainTree): Pairing {
    const p = pairings.ofUser(param(c, "id"), user, tree.id);
    if (p === undefined) throw new NotFoundError();
    return p;
  }

  // Connect an agent: a one-time code, and the prompt (and loop prompt) to
  // copy into the agent, with what it should declare. Members only; at most
  // OPEN_PER_USER waiting at once.
  route("POST", "/commons/pairings", async (c) => {
    const user = signedIn(c);
    rateLimit(`pairing-new:${user.id}`, 10);
    const tree = visibleTree(c, user.id);
    const site = siteOf(tree);
    if (!tree.isMember(user.id)) throw new ActionError("Only members of this community can connect an agent.", "not member");
    publicOnly(tree);
    const body = await jsonBody(c);
    const modelFamily = parseModelFamily(body.modelFamily);
    const harness = parseHarness(body.harness);
    // ones whose approval may have landed, out of time, settled first
    for (const p of pairings.mine(user.id, tree.id)) await settleLost(site, p);
    const { pairing, code } = pairings.create(user.id, tree.id, { modelFamily, harness });
    const backend = backendOf(c);
    const expiresAt = new Date(pairing.expiresAt).toISOString();
    return c.json({
      id: pairing.id,
      code,
      expiresAt,
      prompt: pairingPrompt({
        person: store.user(user.id)?.name ?? user.name,
        community: tree.id,
        backend,
        code,
        expiresAt,
        modelFamily,
        harness,
      }),
      loopPrompt: loopPrompt(backend, tree.id),
    });
  });

  // The member's pairings still open or claimed here (no codes: they're
  // shown once), so a page that lost one (a reload, another tab) can approve
  // or reject it.
  route("GET", "/commons/pairings", (c) => {
    const user = signedIn(c);
    rateLimit(`pairing-read:${user.id}`, 120);
    const tree = visibleTree(c, user.id);
    siteOf(tree);
    return c.json({ pairings: pairings.mine(user.id, tree.id).map(pairingView) });
  });

  // The agent claims a code with its key (commons-agent pair). `proof` is
  // the agent key's signature over the claim (pairMessage), so it can only
  // name a key it holds. One claim per code; a bad proof doesn't use it up.
  route("POST", "/commons/pairings/claim", async (c) => {
    rateLimit(`pairing-claim:${clientIp(c)}`, 30);
    const tree = agentSide(c);
    const { code, agentKey, modelFamily, harness, proof } = await jsonBody(c);
    if (!isCommonsPublicKey(agentKey)) throw new ActionError("agentKey must be an ed25519 public key (base64url SPKI DER)");
    // exactly as the agent signed them: tidying them here would break the proof
    if (!isModelFamily(modelFamily)) throw new ActionError("modelFamily must be one lowercase name, like claude, gpt or other.");
    if (!isHarness(harness)) {
      throw new ActionError("harness must be 1-64 printable ASCII characters, words separated by single spaces, like claude-code.");
    }
    const p = pairings.ofCode(code, tree.id);
    if (p === undefined) throw noPairing();
    if (!verifyPairProof({ agentKey, code, community: tree.id, harness, modelFamily }, proof)) {
      throw new ActionError("The proof isn't this agent key's signature over the claim.", "bad proof");
    }
    pairings.claim(p, { agentKey, modelFamily, harness });
    return c.json({ status: "claimed", fingerprint: p.claim!.fingerprint, expiresAt: new Date(p.expiresAt).toISOString() });
  });

  // The agent waits for its owner's answer. A POST, so the code isn't in a
  // URL (and the logs that keep them).
  route("POST", "/commons/pairings/claim-status", async (c) => {
    rateLimit(`pairing-status:${clientIp(c)}`, 120);
    const tree = agentSide(c);
    const { code } = await jsonBody(c);
    const p = pairings.ofCode(code, tree.id);
    if (p === undefined) throw noPairing();
    await settleLost(siteOf(tree), p);
    const status = pairings.status(p);
    return c.json({
      status,
      expiresAt: new Date(p.expiresAt).toISOString(),
      ...(p.claim === undefined ? {} : { fingerprint: p.claim.fingerprint }),
      ...(status === "approved" && p.claim !== undefined ? { agent: { keyId: p.claim.keyId } } : {}),
    });
  });

  // The member's page polls its pairing, to show the claim to approve.
  route("GET", "/commons/pairings/:id", async (c) => {
    const user = signedIn(c);
    rateLimit(`pairing-read:${user.id}`, 120);
    const tree = visibleTree(c, user.id);
    const site = siteOf(tree);
    const p = myPairing(c, user.id, tree);
    await settleLost(site, p);
    pairings.status(p);
    return c.json(pairingView(p));
  });

  // The member approves the claimed agent (after comparing fingerprints):
  // Anthill signs that the agent is theirs and relays it to the coordinator.
  // If that fails the pairing stays approvable. A key the commons already has
  // is done if it's this member's active agent (a repeat), and refused if it's
  // someone else's or was revoked (see CommonsRelay.registerAgent).
  //
  // When no answer comes back (a timeout, a reset, a 5xx) the attestation may
  // be in the ledger all the same: the pairing remembers that (attemptedAt),
  // Anthill asks the coordinator at once, and until it knows, rejecting it
  // asks again (and revokes what landed) and it doesn't expire unasked.
  route("POST", "/commons/pairings/:id/approve", async (c) => {
    const user = signedIn(c);
    rateLimit(`pairing-approve:${user.id}`, 10);
    const tree = visibleTree(c, user.id);
    const site = siteOf(tree);
    const p = myPairing(c, user.id, tree);
    if (!tree.isMember(user.id)) throw new ActionError("Only members of this community can connect an agent.", "not member");
    const status = pairings.status(p);
    const claim = p.claim;
    const agent = claim && { keyId: claim.keyId, modelFamily: claim.modelFamily, harness: claim.harness };
    if (status === "approved") return c.json({ agent });
    if (status === "open") throw new ActionError("No agent has claimed this code yet.", "not claimed");
    if (status === "expired") throw new ActionError("This pairing has expired: connect the agent again.", "expired");
    if (status === "rejected") throw new ActionError("This pairing was rejected: connect the agent again.", "rejected");
    if (p.relaying || claim === undefined) throw new ActionError("This agent is already being approved.", "approving");
    publicOnly(tree);
    p.relaying = true;
    // an earlier attempt that got no answer still may land
    const earlier = p.attemptedAt;
    try {
      const signed = commonsSigner.agent({
        agentKey: claim.agentKey,
        at: new Date().toISOString(),
        community: tree.id,
        harness: claim.harness,
        modelFamily: claim.modelFamily,
        user: user.id,
      });
      p.attemptedAt = Date.now();
      let answer: Awaited<ReturnType<CommonsRelay["registerAgent"]>>;
      try {
        answer = await relay.registerAgent(site, signed);
      } catch (e) {
        if (!(e instanceof RelayError)) {
          // refused, or never sent (over the budget): this one didn't land
          p.attemptedAt = earlier;
          throw e;
        }
        // no answer: it may have landed
        if ((await lostApproval(site, p)) === "active") answer = "already";
        else throw new RelayError(`${e.message} The approval may have gone through all the same: Anthill checks before it lets this pairing end.`);
      } finally {
        relay.forget(site, user.id);
      }
      const taken = () =>
        new ActionError("The commons already has this agent's key, for someone else. Ask your agent to make a new key and pair again.", "key taken");
      if (answer === "taken" || answer === "revoked") p.attemptedAt = earlier;
      if (answer === "taken") throw taken();
      if (answer === "revoked") {
        throw new ActionError("This agent's key was revoked in the commons. Ask your agent to make a new key and pair again.", "key revoked");
      }
      // a repeat: check it really is this member's, active
      if (answer === "already") {
        const known = (await relay.agentsOf(site, user.id, { fresh: true })).find((a) => a.keyId === claim.keyId);
        if (known === undefined || !known.active) throw taken();
      }
      pairings.end(p, "approved");
    } finally {
      p.relaying = false;
    }
    return c.json({ agent });
  });

  // Not the agent you expected (or you changed your mind): the code stops
  // working. An approved agent is revoked instead. After an approval that got
  // no answer, the coordinator is asked first: an agent that landed is
  // revoked before this says rejected, and while Anthill can't tell, the
  // pairing stays as it is.
  route("POST", "/commons/pairings/:id/reject", async (c) => {
    const user = signedIn(c);
    rateLimit(`pairing-reject:${user.id}`, 30);
    const tree = visibleTree(c, user.id);
    const site = siteOf(tree);
    const p = myPairing(c, user.id, tree);
    const status = pairings.status(p);
    if (p.relaying) throw new ActionError("This agent is being approved right now.", "approving");
    if (status === "approved") throw new ActionError("This agent is already approved: revoke it under Your agents.", "approved");
    if (status !== "open" && status !== "claimed") return c.json(pairingView(p));
    if (p.attemptedAt !== undefined && p.claim !== undefined) {
      const { agentKey } = p.claim;
      p.relaying = true;
      try {
        const found = await lostApproval(site, p);
        if (found === "unsure") {
          throw new RelayError(
            "Your approval may have reached the commons, and Anthill can't check that right now. Try again in a minute; if the agent shows under Your agents, revoke it there.",
            "approval unsure",
          );
        }
        if (found === "active") await revokeAgent(site, tree, user.id, agentKey, "rejected by its owner while pairing on Anthill");
      } finally {
        p.relaying = false;
      }
    }
    pairings.end(p, "rejected");
    return c.json(pairingView(p));
  });

  // Your agents in this commons, as its coordinator has them. Signed in, not
  // necessarily still a member: whoever left can still see and revoke theirs,
  // a private community's too. Someone who can't see the community and has
  // no agent there gets the 404 anyone gets.
  async function agentsHere(c: Context, user: string, o: { fresh?: boolean; kind?: "check" | "list" } = {}) {
    const tree = communities.get(cidOf(c));
    if (tree === undefined) throw new NotFoundError();
    const site = siteOf(tree);
    const agents = await relay.agentsOf(site, user, o);
    if (!tree.visibleTo(user) && agents.length === 0) throw new NotFoundError();
    return { tree, site, agents };
  }

  route("GET", "/commons/agents", async (c) => {
    const user = signedIn(c);
    rateLimit(`commons-agents:${user.id}`, 30);
    const { agents } = await agentsHere(c, user.id, { kind: "list" });
    return c.json({ agents: agents.map(agentView) });
  });

  // Revoke one of your agents (a leaked key, a misbehaving agent): Anthill
  // signs the revocation and relays it. No recent sign-in needed: it only
  // protects. Body: optional { reason }. A key that isn't in your (recent)
  // list is refused without asking the coordinator again.
  route("POST", "/commons/agents/:keyId/revoke", async (c) => {
    const user = signedIn(c);
    rateLimit(`commons-revoke:${user.id}`, 10);
    const keyId = param(c, "keyId");
    const reason = parseReason((await optionalJsonBody(c)).reason);
    const notYours = () => new NotFoundError("You have no agent with that key in this commons.");
    if (!/^[0-9a-f]{32}$/.test(keyId)) throw notYours();
    const { tree, site, agents: recent } = await agentsHere(c, user.id);
    if (!recent.some((a) => a.keyId === keyId)) throw notYours();
    const agent = (await relay.agentsOf(site, user.id, { fresh: true })).find((a) => a.keyId === keyId);
    if (agent === undefined) throw notYours();
    if (!agent.active) return c.json({ agent: agentView(agent) });
    if (agent.publicKey === undefined) {
      throw new RelayError("The commons didn't say which key this agent has, so Anthill can't revoke it; try again later.", "no public key");
    }
    if ((await revokeAgent(site, tree, user.id, agent.publicKey, reason)) === "already") {
      const now = (await relay.agentsOf(site, user.id, { fresh: true })).find((a) => a.keyId === keyId);
      if (now === undefined || now.active) throw new RelayError("The commons didn't revoke the agent; try again in a moment.");
      return c.json({ agent: agentView(now) });
    }
    return c.json({ agent: agentView({ ...agent, active: false, revokedReason: reason }) });
  });

  // Every active agent of `user`, in every commons, revoked: before the
  // account is deleted, since nobody could revoke them on Anthill after.
  // Any commons that can't be asked, or doesn't revoke, stops the deletion
  // (an operator whose commons is gone for good takes it out of
  // COMMONS_SITES).
  async function revokeAllAgents(user: string) {
    for (const [id, site] of commonsSites) {
      const tree = communities.get(id);
      if (tree === undefined) continue;
      try {
        for (const agent of await relay.agentsOf(site, user, { fresh: true })) {
          if (!agent.active) continue;
          if (agent.publicKey === undefined) throw new RelayError("the commons didn't say which key one of them has");
          await revokeAgent(site, tree, user, agent.publicKey, "its owner deleted their Anthill account");
        }
      } catch (e) {
        if (!(e instanceof RelayError) && !(e instanceof ActionError)) throw e;
        throw new RelayError(
          `Your agents in the ${id} agent commons couldn't be revoked (${e.message.replace(/[.:]+$/, "")}), so your account wasn't deleted. Try again in a moment.`,
          "agents not revoked",
        );
      }
    }
  }

  // What an agent reads (templates/agent.md, for this community): public to
  // whoever can see the community, cached briefly.
  route("GET", "/commons/agent.md", (c) => {
    rateLimit(`agent-md:${clientIp(c)}`, 60);
    const tree = visibleTree(c, viewerOf(c));
    const body = renderAgentMd({ community: tree.id, backend: backendOf(c), site: siteOf(tree), kitCommit: commonsKit });
    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header("Cache-Control", `${tree.info.visibility === "public" ? "public" : "private"}, max-age=60`);
    return c.body(body);
  });

  app.get("/invites/:code", (c) => {
    const code = param(c, "code");
    const stored = store.invite(code);
    const tree = stored && communities.get(store.communityOf(stored));
    if (tree === undefined) throw new ActionError("This invite link isn't valid.");
    const invite = tree.validInvite(code);
    // Who holds the link sees what they need to decide: the community's name,
    // description and size, and who invited them. A private one's founder
    // and root (and where its commons is) stay for its members.
    const viewer = viewerOf(c);
    const community = summary(tree, viewer);
    return c.json({
      community: tree.visibleTo(viewer) ? community : { ...community, founder: null, rootName: "", commons: null },
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
      // agents and the coordinator read a commons' community without a
      // session (agent.md, the signed tree): it must be public
      for (const id of commonsSites.keys()) {
        const tree = communities.get(id);
        if (tree === undefined) console.warn(`COMMONS_SITES: no community ${id}: its commons does nothing`);
        else if (tree.info.visibility !== "public") {
          console.warn(`COMMONS_SITES: community ${id} is private: its agents can't read agent.md and its coordinator can't pin its tree, and Anthill refuses to pair agents there`);
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
