// End-to-end smoke test of off-chain mode: drives a running backend with a
// software passkey (P-256, "none" attestation) the way a browser would.
// Checks the commons starts empty (with no founder on a fresh data dir). In the
// demo (the seeded tree): registers, signs in, joins, votes, renames, checks
// why actions fail, invites
// a second user, sets a profile, runs a poll, starts public and private
// communities (joining, invites, privacy, settings, renaming across them, one
// name per account, update keys, name cleaning, body limits, no-op writes,
// poll caps and leavers' votes, an emptied tree), adds a second passkey, recovers with the recovery code (which
// ends old sessions and passkeys, once per code), signs out everywhere and
// downloads the log as admin.
//
//   PORT=5098 DATA_DIR=/tmp/anthill-smoke ADMIN_TOKEN=smoke-admin npx tsx src/App.ts
//   BACKEND=http://localhost:5098/ ADMIN_TOKEN=smoke-admin npx tsx scripts/smokeOffchain.ts
//
// The backend must accept ORIGIN (default http://localhost:5173, the backend's
// default ORIGINS) and RP_ID localhost.

import assert from "node:assert/strict";
import { SoftPasskey } from "./softPasskey";

const backend = process.env.BACKEND || "http://localhost:5098/";

async function call(path: string, body?: unknown, token?: string) {
  const res = await fetch(backend + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: any = await res.json();
  return { status: res.status, data };
}

async function register(passkey: SoftPasskey, name: string) {
  const options = await call("auth/register/options", { name });
  assert.equal(options.status, 200, JSON.stringify(options.data));
  const verified = await call("auth/register/verify", {
    flowId: options.data.flowId,
    response: passkey.create(options.data.options),
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  return verified.data as {
    token: string;
    user: { id: string; name: string };
    recoveryCode: string;
  };
}

async function signIn(passkey: SoftPasskey) {
  const options = await call("auth/login/options", {});
  const verified = await call("auth/login/verify", {
    flowId: options.data.flowId,
    response: passkey.get(options.data.options),
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  return verified.data as { token: string; user: { id: string; name: string } };
}

// The seeded tree is the demo community (invite only); the commons starts
// empty and only its founder can start its tree.
const D = "c/demo/";

// A node as served in a community's graph.
async function nodeOf(id: string, cid = "demo") {
  return (await call(`c/${cid}/graph`)).data.nodes[id];
}

async function adminInvite(community: string, under: string) {
  const res = await fetch(`${backend}admin/invites`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ community, under }),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { code: string }).code;
}

async function main() {
  assert.ok(process.env.ADMIN_TOKEN, "set ADMIN_TOKEN (the backend's) to run this");

  // Not signed in: actions are refused.
  assert.equal((await call("action", { fn: "leaveTree" })).status, 401);

  const passkey = new SoftPasskey();
  const session = await register(passkey, "Smoke");
  console.log("registered", session.user);

  const me = await call("auth/me", undefined, session.token);
  assert.deepEqual(me.data.user, session.user);

  // A forged token is refused, also a malformed one (non-ASCII, the
  // signature's length in characters but not in bytes) or one with a tail.
  const [payload, signature] = session.token.split(".");
  for (const bad of [
    `${payload}.AAAA`,
    `${payload}.${"\u00e9".repeat(signature.length)}`,
    `${session.token}.extra`,
    `e30.${signature}`,
  ]) {
    assert.equal((await call("auth/me", undefined, bad)).status, 401, bad);
  }
  {
    const res = await fetch(`${backend}admin/log`, { headers: { Authorization: "Bearer \u00e9" } });
    assert.equal(res.status, 401);
  }

  // Passkeys are asked to verify the user, which the server requires.
  assert.equal(
    (await call("auth/login/options", {})).data.options.userVerification,
    "required",
  );
  // A sign-in without a passkey response is a 400 and leaves the flow usable.
  {
    const options = await call("auth/login/options", {});
    for (const body of [{ flowId: options.data.flowId }, { flowId: options.data.flowId, response: null }]) {
      assert.equal((await call("auth/login/verify", body)).status, 400, JSON.stringify(body));
    }
    const verified = await call("auth/login/verify", {
      flowId: options.data.flowId,
      response: passkey.get(options.data.options),
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.data));
  }
  // Reads of the session don't use up the sign-in rate limit.
  for (let i = 0; i < 70; i++) await call("auth/me", undefined, session.token);
  assert.equal((await call("auth/login/options", {})).status, 200);
  console.log("ok: malformed tokens and passkey responses");

  // The commons is empty. A fresh data dir has no COMMONS_FOUNDER account, so
  // it has no founder and anyone could start it (left empty here).
  const commons = (await call("graph")).data;
  assert.equal(commons.community.id, "commons");
  assert.deepEqual(commons.nodes, {});
  assert.equal(commons.community.founder, null);
  const startable = await call(
    "check",
    { actions: [{ fn: "joinTreeAsRoot", args: { name: "Smoke" } }] },
    session.token,
  );
  assert.deepEqual(startable.data.results, [{ ok: true }]);

  // The demo (the seeded tree) is invite only: join under a leaf with an
  // admin invite.
  const leaf = (await call(`${D}graph`)).data.randomLeaf as string;
  assert.equal((await call("c/demo")).data.community.joinPolicy, "closed");
  const uninvited = await call(
    `${D}action`,
    { fn: "joinTree", args: { name: "Smoke", recipient: leaf } },
    session.token,
  );
  assert.equal(uninvited.status, 400);
  const leafInvite = await adminInvite("demo", leaf);
  const join = await call(
    `${D}action`,
    { fn: "joinTree", args: { name: "Smoke", invite: leafInvite } },
    session.token,
  );
  assert.equal(join.status, 200, JSON.stringify(join.data));
  let node = (await nodeOf(session.user.id));
  assert.equal(node.sentTreeVote, leaf);
  assert.deepEqual(node.sentDagVotes.map((v: any) => v.id), [leaf]);
  console.log("joined under", leaf);

  // Joining twice is refused by the contract rules.
  const again = await call(
    `${D}action`,
    { fn: "joinTree", args: { name: "Smoke", invite: await adminInvite("demo", leaf) } },
    session.token,
  );
  assert.equal(again.status, 400);
  assert.equal(again.data.code, "A lT 2");
  assert.equal(again.data.error, "You're already in the tree.");

  // Vote for the grandparent (two levels up is always votable).
  const grandparent = (await nodeOf(leaf)).sentTreeVote as string;
  const vote = await call(
    `${D}action`,
    { fn: "addDagVote", args: { recipient: grandparent, weight: "1" } },
    session.token,
  );
  assert.equal(vote.status, 200, JSON.stringify(vote.data));

  // Sign in again with the same passkey, rename with the new session.
  const second = await signIn(passkey);
  assert.equal(second.user.id, session.user.id);
  const rename = await call(`${D}action`, { fn: "changeName", args: { name: "Smoke 2" } }, second.token);
  assert.equal(rename.status, 200, JSON.stringify(rename.data));

  node = (await nodeOf(session.user.id));
  assert.equal(node.name, "Smoke 2");

  const graph = (await call(`${D}graph`)).data;
  assert.deepEqual(graph.nodes[session.user.id], node);
  assert.equal(graph.community.id, "demo");
  assert.deepEqual(node.sentDagVotes.map((v: any) => v.id).sort(), [leaf, grandparent].sort());

  // Moving under yourself is refused (it used to detach the voter into a loop).
  const selfMove = await call(
    `${D}action`,
    { fn: "moveTreeVote", args: { recipient: session.user.id } },
    second.token,
  );
  assert.equal(selfMove.status, 400);
  assert.equal(selfMove.data.code, "A mTV 5");

  const history = (await call(`${D}history`)).data.steps;
  assert.equal(history.at(-1).eventName, "ChangeNameEvent");
  console.log("ok: register, sign-in, join, vote, rename; history steps =", history.length);

  // Dry runs explain why actions would fail, without changing anything.
  const checks = await call(
    `${D}check`,
    {
      actions: [
        { fn: "addDagVote", args: { recipient: grandparent } },
        { fn: "moveTreeVote", args: { recipient: session.user.id } },
        { fn: "changeName", args: { name: "Still Smoke" } },
        { fn: "addDagVote", args: { recipient: session.user.id } },
      ],
    },
    session.token,
  );
  assert.equal(checks.status, 200, JSON.stringify(checks.data));
  const [againVote, selfMoveCheck, renameCheck, selfVote] = checks.data.results;
  assert.deepEqual(againVote, {
    ok: false,
    reason: "You already give them a reputation vote.",
    code: "A aDV 2",
  });
  assert.equal(selfMoveCheck.reason, "You can't move under yourself.");
  assert.deepEqual(renameCheck, { ok: true });
  assert.equal(selfVote.ok, false);
  assert.equal((await nodeOf(session.user.id)).name, "Smoke 2");
  console.log("ok: dry-run reasons");

  // Malformed bodies are a 400, and a dry run still answers the other items.
  for (const body of [null, [], "x"]) {
    assert.equal((await call(`${D}action`, body, session.token)).status, 400, JSON.stringify(body));
    assert.equal((await call(`${D}check`, body, session.token)).status, 400, JSON.stringify(body));
    assert.equal((await call("auth/register/options", body)).status, 400, JSON.stringify(body));
  }
  const nullArgs = await call(`${D}action`, { fn: "addDagVote", args: null }, session.token);
  assert.equal(nullArgs.status, 400);
  const mixed = await call(
    `${D}check`,
    { actions: [{ fn: "joinTree", args: null }, { fn: "changeName", args: { name: "Fine" } }] },
    session.token,
  );
  assert.equal(mixed.status, 200, JSON.stringify(mixed.data));
  assert.deepEqual(
    mixed.data.results.map((r: any) => r.ok),
    [false, true],
  );
  // a dry run is a few actions at a time
  const many = Array(6).fill({ fn: "changeName", args: { name: "Fine" } });
  assert.equal((await call(`${D}check`, { actions: many }, session.token)).status, 400);
  // the engine's scratch node and sentinels are nobody to move under
  for (const recipient of [
    "0x0000000000000000000000000000000099999999",
    "0x0000000000000000000000000000000000000001",
  ]) {
    const ghost = await call(`${D}action`, { fn: "moveTreeVote", args: { recipient } }, session.token);
    assert.equal(ghost.status, 400);
    assert.equal(ghost.data.error, "That person isn't in the tree.");
  }
  console.log("ok: malformed bodies and sentinels");

  // Invites: a second person joins under the inviter.
  // The demo is closed: members can't invite, only an admin can.
  const memberInvite = await call(`${D}invites`, {}, session.token);
  assert.equal(memberInvite.status, 400);
  assert.match(memberInvite.data.error, /isn't taking new members/);
  const invite = { data: { code: await adminInvite("demo", session.user.id) } };
  const inviteInfo = await call(`invites/${invite.data.code}`);
  assert.deepEqual(inviteInfo.data.inviter, { id: session.user.id, name: "Smoke 2" });
  const friendKey = new SoftPasskey();
  const friend = await register(friendKey, "Friend");
  const friendJoin = await call(
    `${D}action`,
    { fn: "joinTree", args: { name: "Friend", invite: invite.data.code } },
    friend.token,
  );
  assert.equal(friendJoin.status, 200, JSON.stringify(friendJoin.data));
  assert.equal((await nodeOf(friend.user.id)).sentTreeVote, session.user.id);
  const reuse = await call(`invites/${invite.data.code}`);
  assert.equal(reuse.status, 400);
  assert.equal(reuse.data.error, "This invite has already been used.");
  // People outside the tree can't invite.
  const outsider = await register(new SoftPasskey(), "Outsider");
  assert.equal((await call(`${D}invites`, {}, outsider.token)).status, 400);
  console.log("ok: invite joins under the inviter");

  // Profiles show up on the node.
  const badLink = await call("profile", { bio: "hi", link: "javascript:alert(1)" }, session.token);
  assert.equal(badLink.status, 400);
  const profile = await call(
    "profile",
    { bio: "Smoke tester", link: "https://example.com" },
    session.token,
  );
  assert.equal(profile.status, 200, JSON.stringify(profile.data));
  const withProfile = (await nodeOf(session.user.id));
  assert.equal(withProfile.bio, "Smoke tester");
  assert.equal(withProfile.link, "https://example.com");
  console.log("ok: profile");

  // Polls weighted by reputation.
  const created = await call(
    `${D}polls`,
    { question: "Lunch?", options: ["Pizza", "Sushi"] },
    session.token,
  );
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const pollId = created.data.poll.id;
  assert.equal((await call(`${D}polls/${pollId}/vote`, { option: 0 }, session.token)).status, 200);
  assert.equal((await call(`${D}polls/${pollId}/vote`, { option: 1 }, friend.token)).status, 200);
  assert.equal((await call(`${D}polls/${pollId}/vote`, { option: 0 }, outsider.token)).status, 400);
  const graphNow = (await call(`${D}graph`)).data.nodes;
  let poll = (await call(`${D}polls`, undefined, session.token)).data.polls.find(
    (p: any) => p.id === pollId,
  );
  assert.equal(poll.myVote, 0);
  assert.equal(poll.tally[0].weight, graphNow[session.user.id].currentRep);
  assert.equal(poll.tally[1].weight, graphNow[friend.user.id].currentRep);
  assert.equal((await call(`${D}polls/${pollId}/close`, {}, friend.token)).status, 400);
  const closed = await call(`${D}polls/${pollId}/close`, {}, session.token);
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.ok(closed.data.poll.closedAt);
  assert.equal((await call(`${D}polls/${pollId}/vote`, { option: 1 }, session.token)).status, 400);
  console.log("ok: reputation-weighted poll");

  // Communities: a public one anyone can join.
  const pub = await call(
    "communities",
    { id: "smoke-public", name: "Smoke Club", visibility: "public", joinPolicy: "open" },
    session.token,
  );
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  assert.equal(pub.data.community.members, 1);
  assert.equal(pub.data.community.isFounder, true);
  assert.equal(pub.data.community.you.rank, 1);
  for (const id of ["smoke-public", "A!", "admin", "-x-"]) {
    const bad = await call(
      "communities",
      { id, name: "Nope", visibility: "public", joinPolicy: "open" },
      friend.token,
    );
    assert.equal(bad.status, 400, id);
  }
  assert.equal((await call("communities", { id: "x", name: "No" })).status, 401);
  const listed = (await call("communities")).data.communities.map((c: any) => c.id);
  assert.ok(["commons", "demo", "smoke-public"].every((id) => listed.includes(id)));

  // Joining it under the founder; it's a separate tree.
  const clubJoin = await call(
    "c/smoke-public/action",
    { fn: "joinTree", args: { name: "Friend", recipient: session.user.id } },
    friend.token,
  );
  assert.equal(clubJoin.status, 200, JSON.stringify(clubJoin.data));
  const club = (await call("c/smoke-public/graph")).data;
  assert.equal(club.rootId, session.user.id);
  assert.equal(club.community.members, 2);
  assert.equal(club.nodes[friend.user.id].sentTreeVote, session.user.id);
  assert.equal(club.nodes[outsider.user.id], undefined);

  // Polls and invites belong to their community.
  const clubPoll = await call(
    "c/smoke-public/polls",
    { question: "Club lunch?", options: ["Yes", "No"] },
    friend.token,
  );
  assert.equal(clubPoll.status, 200, JSON.stringify(clubPoll.data));
  const demoPolls = (await call(`${D}polls`)).data.polls.map((p: any) => p.id);
  assert.ok(!demoPolls.includes(clubPoll.data.poll.id));
  assert.equal(
    (await call(`${D}polls/${clubPoll.data.poll.id}/vote`, { option: 0 }, session.token)).status,
    400,
  );
  assert.equal(
    (await call(`c/smoke-public/polls/${clubPoll.data.poll.id}/vote`, { option: 0 }, session.token))
      .status,
    200,
  );
  assert.equal(
    (await call("c/smoke-public/polls", { question: "?", options: ["a", "b"] }, outsider.token))
      .status,
    400,
  );

  // Only the founder changes settings.
  const settings = { name: "Smoke Society", visibility: "public", joinPolicy: "invite" };
  assert.equal((await call("c/smoke-public/settings", settings, friend.token)).status, 400);
  const changed = await call("c/smoke-public/settings", settings, session.token);
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal(changed.data.community.name, "Smoke Society");
  const closedJoin = await call(
    "c/smoke-public/action",
    { fn: "joinTree", args: { name: "Outsider", recipient: friend.user.id } },
    outsider.token,
  );
  assert.equal(closedJoin.status, 400);
  console.log("ok: public community, its polls and settings");

  // A private community is invisible to outsiders and joined by invite only.
  const priv = await call(
    "communities",
    { id: "smoke-private", name: "Back Room", visibility: "private", joinPolicy: "open" },
    session.token,
  );
  assert.equal(priv.status, 200, JSON.stringify(priv.data));
  assert.equal(priv.data.community.joinPolicy, "invite");
  assert.equal((await call("c/smoke-private")).status, 404);
  assert.equal((await call("c/smoke-private/graph", undefined, outsider.token)).status, 404);
  assert.equal((await call("c/smoke-nothing/graph")).status, 404);
  const outsiderList = (await call("communities", undefined, outsider.token)).data.communities;
  assert.ok(!outsiderList.some((c: any) => c.id === "smoke-private"));
  const founderList = (await call("communities", undefined, session.token)).data.communities;
  assert.ok(founderList.some((c: any) => c.id === "smoke-private"));
  const sneak = await call(
    "c/smoke-private/action",
    { fn: "joinTree", args: { name: "Outsider", recipient: session.user.id } },
    outsider.token,
  );
  assert.equal(sneak.status, 404);
  const fakeInvite = await call(
    "c/smoke-private/action",
    { fn: "joinTree", args: { name: "Outsider", invite: "nope" } },
    outsider.token,
  );
  assert.equal(fakeInvite.status, 404);

  const privInvite = await call("c/smoke-private/invites", {}, session.token);
  assert.equal(privInvite.status, 200, JSON.stringify(privInvite.data));
  const privInfo = await call(`invites/${privInvite.data.code}`);
  assert.equal(privInfo.data.community.id, "smoke-private");
  assert.equal(privInfo.data.community.name, "Back Room");
  // The invite only works in its own community.
  const wrongTree = await call(
    "action",
    { fn: "joinTree", args: { name: "Outsider", invite: privInvite.data.code } },
    outsider.token,
  );
  assert.equal(wrongTree.status, 400);
  const privJoin = await call(
    "c/smoke-private/action",
    { fn: "joinTree", args: { name: "Outsider", invite: privInvite.data.code } },
    outsider.token,
  );
  assert.equal(privJoin.status, 200, JSON.stringify(privJoin.data));
  const inside = await call("c/smoke-private/graph", undefined, outsider.token);
  assert.equal(inside.status, 200);
  assert.equal(inside.data.nodes[outsider.user.id].sentTreeVote, session.user.id);
  console.log("ok: private community");

  // Renaming the account renames its node everywhere.
  const renamed = await call("name", { name: "Smoke 3" }, session.token);
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal((await call("auth/me", undefined, session.token)).data.user.name, "Smoke 3");
  for (const cid of ["demo", "smoke-public", "smoke-private"]) {
    const n = (await call(`c/${cid}/graph`, undefined, session.token)).data.nodes[session.user.id];
    assert.equal(n.name, "Smoke 3", cid);
  }
  console.log("ok: rename across communities");

  // The history is sent gzipped; renaming to the same name adds no step.
  const demoHistory = async () => {
    const res = await fetch(`${backend}c/demo/history`, { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-encoding"), "gzip");
    return ((await res.json()) as { steps: { index: number; eventName: string; nodes: unknown[] }[] }).steps;
  };
  const steps = await demoHistory();
  assert.equal(steps.at(-1)!.eventName, "ChangeNameEvent");
  assert.ok(steps.at(-1)!.nodes.length > 60);
  assert.equal((await call("name", { name: "Smoke 3" }, session.token)).status, 200);
  assert.equal((await demoHistory()).length, steps.length);
  console.log("ok: history,", steps.length, "steps");

  // One name per account. A join takes the account's name, not a stale one
  // from the client; changeName as an action renames the account everywhere.
  const sockets: string[] = [];
  const socket = new WebSocket(backend.replace(/^http/, "ws"));
  socket.onmessage = (event) => sockets.push(String(event.data));
  await new Promise((resolve) => (socket.onopen = resolve));
  const stale = await call(
    "communities",
    { id: "smoke-stale", name: "Stale", visibility: "public", joinPolicy: "open" },
    friend.token,
  );
  assert.equal(stale.status, 200, JSON.stringify(stale.data));
  const staleJoin = await call(
    "c/smoke-stale/action",
    { fn: "joinTree", args: { name: "Smoke", recipient: friend.user.id } },
    session.token,
  );
  assert.equal(staleJoin.status, 200, JSON.stringify(staleJoin.data));
  assert.equal((await nodeOf(session.user.id, "smoke-stale")).name, "Smoke 3");
  assert.equal((await call("auth/me", undefined, session.token)).data.user.name, "Smoke 3");
  const actionRename = await call(
    "c/smoke-stale/action",
    { fn: "changeName", args: { name: "Smoke 4" } },
    session.token,
  );
  assert.equal(actionRename.status, 200, JSON.stringify(actionRename.data));
  assert.equal((await call("auth/me", undefined, session.token)).data.user.name, "Smoke 4");
  for (const cid of ["demo", "smoke-public", "smoke-private", "smoke-stale"]) {
    const n = (await call(`c/${cid}/graph`, undefined, session.token)).data.nodes[session.user.id];
    assert.equal(n.name, "Smoke 4", cid);
  }
  const notInTree = await call(
    "c/smoke-stale/action",
    { fn: "changeName", args: { name: "Sneaky" } },
    outsider.token,
  );
  assert.equal(notInTree.status, 400);
  assert.equal((await call("auth/me", undefined, outsider.token)).data.user.name, "Outsider");
  console.log("ok: joins and renames keep one name per account");

  // Updates name the community; a private one by its opaque key.
  const privGraph = (await call("c/smoke-private/graph", undefined, session.token)).data;
  assert.equal((await call("c/smoke-stale/graph")).data.updateKey, "smoke-stale");
  assert.match(privGraph.updateKey, /^p_[0-9a-f]{24}$/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(sockets.includes(`update:${privGraph.updateKey}`), JSON.stringify(sockets));
  assert.ok(sockets.includes("update:smoke-stale"), JSON.stringify(sockets));
  assert.ok(!sockets.some((m) => m === "update" || m.includes("smoke-private")), JSON.stringify(sockets));
  socket.close();
  console.log("ok: private updates are broadcast by key");

  // Names lose invisible and direction-changing characters.
  const evil = await register(new SoftPasskey(), "\u202eEvil\u200b  Name\u0007 ");
  assert.equal(evil.user.name, "Evil Name");
  assert.equal((await call("auth/register/options", { name: "\u200b\u2800 \u202e" })).status, 400);
  assert.equal((await call("name", { name: "\u2066\u2069" }, friend.token)).status, 400);
  console.log("ok: names are cleaned");

  // Bodies are small: a big one is refused before it's read.
  const big = JSON.stringify({ bio: "x".repeat(100_000) });
  const tooBig = await fetch(`${backend}profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${friend.token}` },
    body: big,
  });
  assert.equal(tooBig.status, 413);
  const chunked = await fetch(`${backend}auth/login/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
  assert.equal(chunked.status, 413);
  console.log("ok: body size limit");

  // Writes that change nothing aren't logged.
  const logLines = async () => {
    const res = await fetch(`${backend}admin/log`, {
      headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
    });
    return (await res.text()).trim().split("\n").length;
  };
  {
    const lines = await logLines();
    const same = await call("profile", { bio: "Smoke tester", link: "https://example.com" }, session.token);
    assert.equal(same.status, 200);
    assert.equal((await call("name", { name: "Smoke 4" }, session.token)).status, 200);
    const unchanged = { name: "Smoke Society", visibility: "public", joinPolicy: "invite" };
    assert.equal((await call("c/smoke-public/settings", unchanged, session.token)).status, 200);
    assert.equal(await logLines(), lines);
  }

  // Polls: each member has a few open ones at most. Only members' votes count:
  // whoever leaves loses theirs (also when they come back), and the founder
  // can close a poll whose creator left.
  {
    const ask = (question: string) =>
      call("c/smoke-stale/polls", { question, options: ["Yes", "No"] }, session.token);
    const asked = [];
    for (let i = 0; i < 5; i++) {
      const res = await ask(`Question ${i}?`);
      assert.equal(res.status, 200, JSON.stringify(res.data));
      asked.push(res.data.poll.id as string);
    }
    const sixth = await ask("One more?");
    assert.equal(sixth.status, 400);
    assert.match(sixth.data.error, /5 open polls/);
    const [first, second] = asked;
    for (const id of [first, second]) {
      assert.equal((await call(`c/smoke-stale/polls/${id}/vote`, { option: 0 }, session.token)).status, 200);
      assert.equal((await call(`c/smoke-stale/polls/${id}/vote`, { option: 1 }, friend.token)).status, 200);
    }
    const lines = await logLines();
    assert.equal((await call(`c/smoke-stale/polls/${first}/vote`, { option: 0 }, session.token)).status, 200);
    assert.equal(await logLines(), lines);
    const pollOf = async (id: string, token: string) =>
      (await call("c/smoke-stale/polls", undefined, token)).data.polls.find((p: any) => p.id === id);
    assert.equal((await pollOf(first, friend.token)).canClose, false);
    assert.equal((await pollOf(first, session.token)).canClose, true);
    assert.equal((await call(`c/smoke-stale/polls/${first}/close`, {}, friend.token)).status, 400);

    assert.equal((await call("c/smoke-stale/action", { fn: "leaveTree" }, session.token)).status, 200);
    let left = await pollOf(first, friend.token);
    assert.deepEqual(left.tally.map((t: any) => t.voters), [0, 1]);
    assert.equal(left.tally[0].weight, "0");
    assert.equal(left.canClose, true);
    const founderClose = await call(`c/smoke-stale/polls/${first}/close`, {}, friend.token);
    assert.equal(founderClose.status, 200, JSON.stringify(founderClose.data));
    assert.deepEqual(founderClose.data.poll.tally.map((t: any) => t.voters), [0, 1]);

    // back in the tree: the old vote on the open poll doesn't count again
    const back = await call(
      "c/smoke-stale/action",
      { fn: "joinTree", args: { name: "Old Name", recipient: friend.user.id } },
      session.token,
    );
    assert.equal(back.status, 200, JSON.stringify(back.data));
    assert.equal((await nodeOf(session.user.id, "smoke-stale")).name, "Smoke 4");
    left = await pollOf(second, session.token);
    assert.deepEqual(left.tally.map((t: any) => t.voters), [0, 1]);
    assert.equal(left.myVote, undefined);
    assert.equal((await call(`c/smoke-stale/polls/${second}/vote`, { option: 0 }, session.token)).status, 200);
    assert.deepEqual((await pollOf(second, session.token)).tally.map((t: any) => t.voters), [1, 1]);
  }
  console.log("ok: poll caps, leavers' votes, founder closes");

  // A tree everyone left still serves, and its founder can restart it.
  const solo = await call(
    "communities",
    { id: "smoke-solo", name: "Solo", visibility: "public", joinPolicy: "invite" },
    friend.token,
  );
  assert.equal(solo.status, 200, JSON.stringify(solo.data));
  assert.equal((await call("c/smoke-solo/action", { fn: "leaveTree" }, friend.token)).status, 200);
  const empty = (await call("c/smoke-solo/graph")).data;
  assert.equal(empty.community.members, 0);
  assert.deepEqual(empty.nodes, {});
  const takeover = await call(
    "c/smoke-solo/action",
    { fn: "joinTreeAsRoot", args: { name: "Outsider" } },
    outsider.token,
  );
  assert.equal(takeover.status, 400);
  const restart = await call(
    "c/smoke-solo/action",
    { fn: "joinTreeAsRoot", args: { name: "Friend" } },
    friend.token,
  );
  assert.equal(restart.status, 200, JSON.stringify(restart.data));
  assert.equal((await call("c/smoke-solo/graph")).data.rootId, friend.user.id);
  console.log("ok: emptied community");

  // A second passkey for the same account.
  const addOptions = await call("auth/passkeys/options", {}, session.token);
  assert.equal(addOptions.status, 200, JSON.stringify(addOptions.data));
  const laptop = new SoftPasskey();
  const added = await call(
    "auth/passkeys/verify",
    { flowId: addOptions.data.flowId, response: laptop.create(addOptions.data.options) },
    session.token,
  );
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.equal((await signIn(laptop)).user.id, session.user.id);
  console.log("ok: second passkey");

  // Recovery: the code registers a new passkey and is then replaced.
  const recoverOptions = await call("auth/recover/options", { code: session.recoveryCode });
  assert.equal(recoverOptions.status, 200, JSON.stringify(recoverOptions.data));
  const newPhone = new SoftPasskey();
  const recovered = await call("auth/recover/verify", {
    flowId: recoverOptions.data.flowId,
    response: newPhone.create(recoverOptions.data.options),
  });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
  assert.equal(recovered.data.user.id, session.user.id);
  assert.notEqual(recovered.data.recoveryCode, session.recoveryCode);
  assert.equal(
    (await call("auth/recover/options", { code: session.recoveryCode })).status,
    401,
  );
  assert.equal((await signIn(newPhone)).user.id, session.user.id);
  // Recovery ended the earlier sessions and removed the other passkeys.
  const oldMe = await call("auth/me", undefined, session.token);
  assert.equal(oldMe.status, 401);
  assert.equal(oldMe.data.error, "session expired");
  for (const old of [passkey, laptop]) {
    const options = await call("auth/login/options", {});
    const res = await call("auth/login/verify", {
      flowId: options.data.flowId,
      response: old.get(options.data.options),
    });
    assert.equal(res.status, 401, JSON.stringify(res.data));
  }
  assert.equal((await call("auth/me", undefined, recovered.data.token)).status, 200);
  console.log("ok: recovery code");

  // A code is used once: of two flows it opened, only the newest is open, and
  // a flow dies when the code is replaced.
  {
    const code = recovered.data.recoveryCode;
    const first = await call("auth/recover/options", { code });
    const second = await call("auth/recover/options", { code });
    const stale = await call("auth/recover/verify", {
      flowId: first.data.flowId,
      response: new SoftPasskey().create(first.data.options),
    });
    assert.equal(stale.status, 401, JSON.stringify(stale.data));
    const rotated = await call("auth/recovery-code", {}, recovered.data.token);
    assert.equal(rotated.status, 200, JSON.stringify(rotated.data));
    const afterRotation = await call("auth/recover/verify", {
      flowId: second.data.flowId,
      response: new SoftPasskey().create(second.data.options),
    });
    assert.equal(afterRotation.status, 401, JSON.stringify(afterRotation.data));
    assert.equal((await call("auth/me", undefined, recovered.data.token)).status, 200);
  }
  console.log("ok: recovery codes are single-use");

  // Sign out everywhere ends every session, the caller's too; the passkey
  // still signs in.
  {
    const a = await signIn(newPhone);
    const b = await signIn(newPhone);
    assert.equal((await call("auth/sign-out-everywhere", {}, a.token)).status, 200);
    for (const t of [a.token, b.token, recovered.data.token]) {
      assert.equal((await call("auth/me", undefined, t)).status, 401);
    }
    const again = await signIn(newPhone);
    assert.equal((await call("auth/me", undefined, again.token)).status, 200);
  }
  console.log("ok: sign out everywhere");

  // Admin log download.
  assert.equal((await call("admin/log")).status, 401);
  const adminToken = process.env.ADMIN_TOKEN;
  {
    const res = await fetch(`${backend}admin/log`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split("\n");
    assert.ok(lines.length > 10);
    console.log("ok: admin log,", lines.length, "entries");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
