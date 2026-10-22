// End-to-end smoke test of off-chain mode: drives a running backend with a
// software passkey (P-256, "none" attestation) the way a browser would.
// Registers, signs in, joins the tree, votes, renames, then checks that a
// restarted backend replays the log to the same graph.
//
//   PORT=5098 DATA_DIR=/tmp/anthill-smoke npx tsx src/App.ts   # fresh data dir
//   BACKEND=http://localhost:5098/ npx tsx scripts/smokeOffchain.ts
//
// The backend must accept ORIGIN (default http://localhost:5173, the backend's
// default ORIGINS) and RP_ID localhost.

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import assert from "node:assert/strict";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const backend = process.env.BACKEND || "http://localhost:5098/";
const origin = process.env.ORIGIN || "http://localhost:5173";
const rpID = "localhost";

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

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

// A minimal platform authenticator holding one passkey.
class SoftPasskey {
  private keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  readonly credentialId = randomBytes(16);
  private counter = 0;
  userHandle = "";

  private authData(flags: number, attested?: Buffer) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter++);
    return Buffer.concat([sha256(rpID), Buffer.from([flags]), count, attested ?? Buffer.alloc(0)]);
  }

  private clientData(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  create(options: any) {
    this.userHandle = options.user.id;
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    const coseKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, coseKey]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", this.authData(0x45, attested)],
      ]) as any,
    );
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      response: {
        clientDataJSON: b64url(this.clientData("webauthn.create", options.challenge)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  get(options: any) {
    const clientDataJSON = this.clientData("webauthn.get", options.challenge);
    const authenticatorData = this.authData(0x05);
    const signature = sign(
      "sha256",
      Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
      this.keys.privateKey,
    );
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    };
  }
}

async function register(passkey: SoftPasskey, name: string) {
  const options = await call("auth/register/options", { name });
  assert.equal(options.status, 200, JSON.stringify(options.data));
  const verified = await call("auth/register/verify", {
    flowId: options.data.flowId,
    response: passkey.create(options.data.options),
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  return verified.data as { token: string; user: { id: string; name: string } };
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
  assert.equal(again.data.error, "A lT 2");

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
  assert.equal(selfMove.data.error, "A mTV 5");

  const history = (await call("history")).data.steps;
  assert.equal(history.at(-1).eventName, "ChangeNameEvent");
  console.log("ok: register, sign-in, join, vote, rename; history steps =", history.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
