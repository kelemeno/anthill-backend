// Checks what Anthill signs for a linked agent commons (src/commonsLink.ts),
// no server needed: the message bytes match the commons' (the same strings
// agent-commons pins in test/anthill.test.ts), signatures verify under the
// served public key, the tree holds only members the root reaches with the
// root under null, and the key survives a restart.
//
//   npx tsx scripts/commonsLinkChecks.ts

import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonsSigner, isCommonsPublicKey, ownerMessage, treeMessage } from "../src/commonsLink";
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
} finally {
  rmSync(dir, { recursive: true, force: true });
}
