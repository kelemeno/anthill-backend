// The off-chain server's routes: passkey sign-in, accounts, communities and,
// inside each community (/c/<id>/...), its tree, actions, invites and polls.
// The original unscoped paths (/graph, /action, ...) still answer for the
// default community, so pages loaded before communities existed keep working.
//
// Private communities answer 404 to anyone who isn't a member, as if they
// didn't exist; the only way in is an invite.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import type { AnthillContractType } from "./anthillContract";
import { PasskeyAuth } from "./auth";
import { address0, type GraphData } from "./dagBase";
import { type History, snapshotNodes } from "./dagHistory";
import { loadAnthillGraph } from "./dagLoading";
import {
  calculateDepthAndRelRoot,
  calculateReputation,
  findRandomLeaf,
} from "./dagProcessing";
import type { AnthillEngine, EngineEvent, SeedGraph } from "./engine";
import { clientIp, jsonBody, NotFoundError, rateLimit, requireAdmin } from "./http";
import { NodeDataStoreCollapse, type NodeDataString } from "./nodeData";
import { ActionError, Communities, type Executed, type OffchainTree } from "./offchain";
import { Polls, setProfile } from "./social";
import {
  type ActionEntry,
  bigintReviver,
  DEFAULT_COMMUNITY,
  Store,
} from "./store";

type Snapshot = { graph: SeedGraph; history: History; randomLeaf: string };

// The seeded tree (the original Anthill one) is a demo; the commons is for
// real members, and starts empty. Its founder starts its tree: Kalman's
// account, the only real person in the original tree when it moved.
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

// What's served for one community, rebuilt after every action.
class TreeView {
  graph: GraphData = { rootId: address0, maxRelRootDepth: 6, dict: {} };
  version = 0;
  randomLeaf = address0;
  history: History = { steps: [] };

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

  pushStep(entry: ActionEntry, events: EngineEvent[]) {
    const args = entry.action.args as Record<string, string | undefined>;
    const index = this.history.steps.length;
    this.history.steps.push({
      index,
      eventName: events[events.length - 1]?.eventName ?? entry.action.fn,
      voter: entry.by,
      recipient: args.recipient ?? "",
      name: args.name ?? "",
      weight: args.weight ?? "0",
      blockNumber: index,
      nodes: snapshotNodes(this.graph),
    });
  }
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
// start(), which rebuilds everything from the log.
export function offchainServer(app: Hono, broadcast: (message: string) => void) {
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
    store.moveCommons({ ...DEMO, createdAt: new Date().toISOString() }, COMMONS_FOUNDER);
  }

  const auth = new PasskeyAuth(store);
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
        (id) => tree.engine.isInTree(id),
        (id) => viewOf(tree).graph.dict[id]?.currentRep ?? 0n,
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

  // Tell open pages to reload. Private communities' ids aren't broadcast.
  function notify(tree: OffchainTree) {
    broadcast(tree.info.visibility === "public" ? `update:${tree.id}` : "update");
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
    const { dict, rootId } = viewOf(tree).graph;
    const members = tree.engine.members();
    const me = viewer !== undefined && tree.engine.isInTree(viewer) ? dict[viewer] : undefined;
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

  app.post("/auth/register/options", async (c) => {
    const { name } = await jsonBody(c);
    if (typeof name !== "string" || name.trim() === "" || name.trim().length > 40) {
      throw new ActionError("Names must be 1-40 characters.");
    }
    return c.json(await auth.registrationOptions(name.trim()));
  });

  app.post("/auth/register/verify", async (c) => {
    const { flowId, response } = await jsonBody(c);
    return c.json(await auth.verifyRegistration(flowId, response));
  });

  app.post("/auth/login/options", async (c) => {
    return c.json(await auth.authenticationOptions());
  });

  app.post("/auth/login/verify", async (c) => {
    const { flowId, response } = await jsonBody(c);
    return c.json(await auth.verifyAuthentication(flowId, response));
  });

  app.get("/auth/me", (c) => {
    const user = signedIn(c);
    return c.json({ user, profile: store.profile(user.id) ?? { bio: "", link: "" } });
  });

  // Another passkey (device) for the signed-in account.
  app.post("/auth/passkeys/options", async (c) => {
    return c.json(await auth.addPasskeyOptions(signedIn(c)));
  });

  app.post("/auth/passkeys/verify", async (c) => {
    const user = signedIn(c);
    const { flowId, response } = await jsonBody(c);
    return c.json(await auth.verifyAddPasskey(user, flowId, response));
  });

  // Lost every passkey: register a new one with the recovery code.
  app.post("/auth/recover/options", async (c) => {
    rateLimit(`recover:${clientIp(c)}`, 10);
    const { code } = await jsonBody(c);
    if (typeof code !== "string") throw new ActionError("Enter your recovery code.");
    return c.json(await auth.recoveryOptions(code));
  });

  app.post("/auth/recover/verify", async (c) => {
    const { flowId, response } = await jsonBody(c);
    return c.json(await auth.verifyRecovery(flowId, response));
  });

  app.post("/auth/recovery-code", (c) => {
    return c.json({ recoveryCode: auth.newRecoveryCode(signedIn(c)) });
  });

  // Rename the account, and its node in every community it's in.
  app.post("/name", async (c) => {
    const user = signedIn(c);
    const body = await jsonBody(c);
    await serially(async () => {
      const renamed = communities.rename(user, body);
      for (const executed of renamed) await record(executed);
    });
    broadcast("update");
    return c.json({ user: store.user(user.id) });
  });

  // Bio and link, shown in every community.
  app.post("/profile", async (c) => {
    const profile = setProfile(store, signedIn(c).id, await jsonBody(c));
    broadcast("update");
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
    notify(created!.tree);
    return c.json({ community: summary(created!.tree, user.id) });
  });

  app.get("/c/:cid", (c) => {
    const viewer = viewerOf(c);
    return c.json({ community: summary(visibleTree(c, viewer), viewer) });
  });

  // Founder only: name, description, visibility and join policy.
  app.post("/c/:cid/settings", async (c) => {
    const user = signedIn(c);
    const tree = visibleTree(c, user.id);
    communities.updateSettings(user.id, tree, await jsonBody(c));
    broadcast("update");
    return c.json({ community: summary(tree, user.id) });
  });

  ////////////////////////////////////////////
  //// inside a community

  // The whole served tree in one response. `version` changes on every update.
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
      rootId: view.graph.rootId,
      maxRelRootDepth: view.graph.maxRelRootDepth,
      randomLeaf: view.randomLeaf,
      config: { inviteOnly: tree.info.joinPolicy === "invite" },
      community: summary(tree, viewer),
      nodes,
    });
  });

  // Every past step of the tree, each with a snapshot of all nodes.
  route("GET", "/history", (c) => {
    return c.json(viewOf(visibleTree(c, viewerOf(c))).history);
  });

  // Run one tree action as the signed-in user.
  route("POST", "/action", async (c) => {
    const user = signedIn(c);
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
    await serially(async () => {
      await record(tree.execute(user.id, body));
    });
    notify(tree);
    return c.json({ ok: true });
  });

  // Dry-run up to 20 actions: for each, whether it would work and if not why.
  route("POST", "/check", async (c) => {
    const user = signedIn(c);
    const tree = visibleTree(c, user.id);
    const { actions } = await jsonBody(c);
    if (!Array.isArray(actions) || actions.length > 20) {
      throw new ActionError("expected up to 20 actions");
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
    const tree = visibleTree(c, user.id);
    return c.json({ poll: pollsOf(tree).createPoll(user.id, await jsonBody(c)) });
  });

  route("POST", "/polls/:id/vote", async (c) => {
    const user = signedIn(c);
    const tree = visibleTree(c, user.id);
    return c.json({
      poll: pollsOf(tree).votePoll(user.id, param(c, "id"), await jsonBody(c)),
    });
  });

  route("POST", "/polls/:id/close", (c) => {
    const user = signedIn(c);
    const tree = visibleTree(c, user.id);
    return c.json({ poll: pollsOf(tree).closePoll(user.id, param(c, "id")) });
  });

  ////////////////////////////////////////////
  //// invite links (global: the code says which community)

  app.get("/invites/:code", (c) => {
    const code = param(c, "code");
    const stored = store.invite(code);
    const tree = stored && communities.get(store.communityOf(stored));
    if (tree === undefined) throw new ActionError("This invite link isn't valid.");
    const invite = tree.validInvite(code);
    return c.json({
      community: summary(tree, viewerOf(c)),
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
      await communities.load(record);
      for (const tree of communities.all()) await viewOf(tree).rebuild(tree.engine);
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
