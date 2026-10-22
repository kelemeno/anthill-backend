// End-to-end smoke test of off-chain mode: drives a running backend with a
// software passkey (P-256, "none" attestation) the way a browser would.
// Registers, signs in, joins, votes, renames, checks why actions fail, invites
// a second user, sets a profile, runs a poll, adds a second passkey, recovers
// with the recovery code and downloads the log as admin.
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

async function main() {
  // Not signed in: actions are refused.
  assert.equal((await call("action", { fn: "leaveTree" })).status, 401);

  const passkey = new SoftPasskey();
  const session = await register(passkey, "Smoke");
  console.log("registered", session.user);

  const me = await call("auth/me", undefined, session.token);
  assert.deepEqual(me.data.user, session.user);

  // A forged token is refused.
  const forged = `${session.token.split(".")[0]}.AAAA`;
  assert.equal((await call("auth/me", undefined, forged)).status, 401);

  // Join under a leaf.
  const leaf = (await call("randomLeaf")).data.randomLeaf as string;
  const join = await call(
    "action",
    { fn: "joinTree", args: { name: "Smoke", recipient: leaf } },
    session.token,
  );
  assert.equal(join.status, 200, JSON.stringify(join.data));
  let node = (await call(`id/${session.user.id}`)).data.nodeData;
  assert.equal(node.sentTreeVote, leaf);
  assert.deepEqual(node.sentDagVotes.map((v: any) => v.id), [leaf]);
  console.log("joined under", leaf);

  // Joining twice is refused by the contract rules.
  const again = await call(
    "action",
    { fn: "joinTree", args: { name: "Smoke", recipient: leaf } },
    session.token,
  );
  assert.equal(again.status, 400);
  assert.equal(again.data.code, "A lT 2");
  assert.equal(again.data.error, "You're already in the tree.");

  // Vote for the grandparent (two levels up is always votable).
  const grandparent = (await call(`id/${leaf}`)).data.nodeData.sentTreeVote as string;
  const vote = await call(
    "action",
    { fn: "addDagVote", args: { recipient: grandparent, weight: "1" } },
    session.token,
  );
  assert.equal(vote.status, 200, JSON.stringify(vote.data));

  // Sign in again with the same passkey, rename with the new session.
  const second = await signIn(passkey);
  assert.equal(second.user.id, session.user.id);
  const rename = await call("action", { fn: "changeName", args: { name: "Smoke 2" } }, second.token);
  assert.equal(rename.status, 200, JSON.stringify(rename.data));

  node = (await call(`id/${session.user.id}`)).data.nodeData;
  assert.equal(node.name, "Smoke 2");

  // The whole-graph endpoint serves the same nodes as /id.
  const graph = (await call("graph")).data;
  assert.deepEqual(graph.nodes[session.user.id], node);
  assert.equal(graph.rootId, (await call("rootId")).data.id);
  assert.deepEqual(node.sentDagVotes.map((v: any) => v.id).sort(), [leaf, grandparent].sort());

  // Moving under yourself is refused (it used to detach the voter into a loop).
  const selfMove = await call(
    "action",
    { fn: "moveTreeVote", args: { recipient: session.user.id } },
    second.token,
  );
  assert.equal(selfMove.status, 400);
  assert.equal(selfMove.data.code, "A mTV 5");

  const history = (await call("history")).data.steps;
  assert.equal(history.at(-1).eventName, "ChangeNameEvent");
  console.log("ok: register, sign-in, join, vote, rename; history steps =", history.length);

  // Dry runs explain why actions would fail, without changing anything.
  const checks = await call(
    "check",
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
  assert.equal((await call(`id/${session.user.id}`)).data.nodeData.name, "Smoke 2");
  console.log("ok: dry-run reasons");

  // Invites: a second person joins under the inviter.
  const invite = await call("invites", {}, session.token);
  assert.equal(invite.status, 200, JSON.stringify(invite.data));
  const inviteInfo = await call(`invites/${invite.data.code}`);
  assert.deepEqual(inviteInfo.data.inviter, { id: session.user.id, name: "Smoke 2" });
  const friendKey = new SoftPasskey();
  const friend = await register(friendKey, "Friend");
  const friendJoin = await call(
    "action",
    { fn: "joinTree", args: { name: "Friend", invite: invite.data.code } },
    friend.token,
  );
  assert.equal(friendJoin.status, 200, JSON.stringify(friendJoin.data));
  assert.equal((await call(`id/${friend.user.id}`)).data.nodeData.sentTreeVote, session.user.id);
  const reuse = await call(`invites/${invite.data.code}`);
  assert.equal(reuse.status, 400);
  assert.equal(reuse.data.error, "This invite has already been used.");
  // People outside the tree can't invite.
  const outsider = await register(new SoftPasskey(), "Outsider");
  assert.equal((await call("invites", {}, outsider.token)).status, 400);
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
  const withProfile = (await call(`id/${session.user.id}`)).data.nodeData;
  assert.equal(withProfile.bio, "Smoke tester");
  assert.equal(withProfile.link, "https://example.com");
  console.log("ok: profile");

  // Polls weighted by reputation.
  const created = await call(
    "polls",
    { question: "Lunch?", options: ["Pizza", "Sushi"] },
    session.token,
  );
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const pollId = created.data.poll.id;
  assert.equal((await call(`polls/${pollId}/vote`, { option: 0 }, session.token)).status, 200);
  assert.equal((await call(`polls/${pollId}/vote`, { option: 1 }, friend.token)).status, 200);
  assert.equal((await call(`polls/${pollId}/vote`, { option: 0 }, outsider.token)).status, 400);
  const graphNow = (await call("graph")).data.nodes;
  let poll = (await call("polls", undefined, session.token)).data.polls.find(
    (p: any) => p.id === pollId,
  );
  assert.equal(poll.myVote, 0);
  assert.equal(poll.tally[0].weight, graphNow[session.user.id].currentRep);
  assert.equal(poll.tally[1].weight, graphNow[friend.user.id].currentRep);
  assert.equal((await call(`polls/${pollId}/close`, {}, friend.token)).status, 400);
  const closed = await call(`polls/${pollId}/close`, {}, session.token);
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.ok(closed.data.poll.closedAt);
  assert.equal((await call(`polls/${pollId}/vote`, { option: 1 }, session.token)).status, 400);
  console.log("ok: reputation-weighted poll");

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
  console.log("ok: recovery code");

  // Admin log download.
  assert.equal((await call("admin/log")).status, 401);
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken) {
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
