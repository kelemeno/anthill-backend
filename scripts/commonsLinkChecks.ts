// Checks what Anthill signs for a linked agent commons (src/commonsLink.ts),
// no server needed: the message bytes match the commons' (the same strings
// agent-commons pins in test/anthill.test.ts: the tree, owner, agent,
// agent-revoke and pair messages), signatures verify under the
// served public key, the tree holds only members the root reaches with the
// root under null, and the key survives a restart.
//
//   npx tsx scripts/commonsLinkChecks.ts

import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentMessage,
  agentRevokeMessage,
  CommonsSigner,
  isCommonsPublicKey,
  ownerMessage,
  pairMessage,
  treeMessage,
} from "../src/commonsLink";
import { Communities } from "../src/offchain";
import { Store } from "../src/store";

const ok = (name: string) => console.log(`ok: ${name}`);

assert.equal(
  treeMessage({ community: "builders", version: 7, at: "2026-01-01T00:00:00.000Z", parents: { "0xb": "0xa", "0xa": null } }),
  'anthill-commons/tree/v1\n{"at":"2026-01-01T00:00:00.000Z","community":"builders","parents":{"0xa":null,"0xb":"0xa"},"version":7}',
);
assert.equal(
  ownerMessage({ community: "builders", user: "0xa", publicKey: "KEY", at: "2026-01-01T00:00:00.000Z" }),
  'anthill-commons/owner/v1\n{"at":"2026-01-01T00:00:00.000Z","community":"builders","publicKey":"KEY","user":"0xa"}',
);
const user = `0x${"a".repeat(40)}`;
assert.equal(
  agentMessage({ agentKey: "KEY", at: "2026-01-01T00:00:00.000Z", community: "builders", harness: "claude-code", modelFamily: "claude", user }),
  `anthill-commons/agent/v1\n{"agentKey":"KEY","at":"2026-01-01T00:00:00.000Z","community":"builders","harness":"claude-code","modelFamily":"claude","user":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`,
);
assert.equal(
  agentRevokeMessage({ agentKey: "KEY", at: "2026-01-01T00:00:00.000Z", community: "builders", reason: "lost", user }),
  `anthill-commons/agent-revoke/v1\n{"agentKey":"KEY","at":"2026-01-01T00:00:00.000Z","community":"builders","reason":"lost","user":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`,
);
assert.equal(
  pairMessage({ agentKey: "KEY", code: "ABCD-EFGH-IJKL-MNOP-QRST-UVWX", community: "builders", harness: "claude-code", modelFamily: "claude" }),
  'anthill-commons/pair/v1\n{"agentKey":"KEY","code":"ABCD-EFGH-IJKL-MNOP-QRST-UVWX","community":"builders","harness":"claude-code","modelFamily":"claude"}',
);
ok("message bytes match the commons'");

const dir = mkdtempSync(join(tmpdir(), "anthill-commons-"));
try {
  const signer = new CommonsSigner(dir, {});
  assert.ok(isCommonsPublicKey(signer.publicKey));
  assert.equal(new CommonsSigner(dir, {}).publicKey, signer.publicKey);
  ok("the signing key is made once and kept in the data folder");

  const pub = createPublicKey({ key: Buffer.from(signer.publicKey, "base64url"), format: "der", type: "spki" });
  const check = (message: string, sig: string) => verify(null, Buffer.from(message, "utf8"), pub, Buffer.from(sig, "base64url"));

  const communities = new Communities(new Store(join(dir, "data")));
  const founder = { id: `0x${"1".repeat(40)}`, name: "Founder" };
  const joiner = `0x${"2".repeat(40)}`;
  const { tree } = communities.create(founder, { id: "builders", name: "Builders", visibility: "public", joinPolicy: "open" });
  tree.execute(joiner, { fn: "joinTree", args: { name: "Joiner", recipient: founder.id } });

  const { snapshot, signature } = signer.tree(tree, 3, "2026-01-01T00:00:00.000Z");
  assert.ok(check(treeMessage(snapshot), signature));
  assert.deepEqual(snapshot.parents, { [founder.id]: null, [joiner]: founder.id });
  ok("the signed tree is the members under their parents, the root under null");

  const key = new CommonsSigner(mkdtempSync(join(dir, "k")), {}).publicKey;
  const owner = signer.owner("builders", joiner, key, "2026-01-01T00:00:00.000Z");
  assert.ok(check(ownerMessage(owner.attestation), owner.signature));
  assert.ok(!isCommonsPublicKey(`${key}=`));
  assert.ok(!isCommonsPublicKey("not a key"));
  ok("owner attestations verify; only canonical ed25519 keys are vouched for");

  const agent = signer.agent({ agentKey: key, at: "2026-01-01T00:00:00.000Z", community: "builders", harness: "claude-code", modelFamily: "claude", user: joiner });
  assert.ok(check(agentMessage(agent.attestation), agent.signature));
  const revoke = signer.agentRevoke({ agentKey: key, at: "2026-01-01T00:00:00.000Z", community: "builders", reason: "lost", user: joiner });
  assert.ok(check(agentRevokeMessage(revoke.attestation), revoke.signature));
  // only the message's fields are signed and handed on
  const extra = signer.agent({ ...agent.attestation, extra: "x" } as typeof agent.attestation);
  assert.deepEqual(Object.keys(extra.attestation).sort(), ["agentKey", "at", "community", "harness", "modelFamily", "user"]);
  ok("agent and agent-revoke attestations verify");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
