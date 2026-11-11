// Checks of sessions that need a clock or a restart, run in-process against a
// throwaway data dir (no server needed): account changes need a recent
// sign-in, tokens from before session versions keep working until the user
// signs out everywhere, and sign-outs and recoveries survive a restart.
//
//   npx tsx scripts/authChecks.ts

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthError, PasskeyAuth } from "../src/auth";
import { Store } from "../src/store";
import { SoftPasskey } from "./softPasskey";

const bearer = (token: string) => `Bearer ${token}`;

function refused(fn: () => unknown, message: string, code?: string) {
  assert.throws(fn, (e) => e instanceof AuthError && e.message === message && e.code === code);
}

async function main() {
  delete process.env.SESSION_SECRET; // the token below is signed with the data dir's
  const dir = mkdtempSync(join(tmpdir(), "anthill-auth-"));
  let store = new Store(dir);
  let auth = new PasskeyAuth(store);

  const phone = new SoftPasskey();
  const reg = await auth.registrationOptions("Ann");
  const ann = await auth.verifyRegistration(reg.flowId, phone.create(reg.options) as any);
  const id = ann.user.id;

  // A new session is fresh; ten minutes later it still works, but account
  // changes ask for a new sign-in.
  assert.equal(auth.freshUserFromHeader(bearer(ann.token)).id, id);
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60_000;
  assert.equal(auth.userFromHeader(bearer(ann.token)).id, id);
  refused(
    () => auth.freshUserFromHeader(bearer(ann.token)),
    "Please sign in again first, to confirm it's you.",
    "reauth",
  );
  const login = await auth.authenticationOptions();
  const again = await auth.verifyAuthentication(login.flowId, phone.get(login.options) as any);
  assert.equal(auth.freshUserFromHeader(bearer(again.token)).id, id);
  Date.now = realNow;
  console.log("ok: account changes need a recent sign-in");

  // A token as issued before versions existed ({uid, exp} only): valid at
  // version 0, never fresh, and ended by sign out everywhere.
  const secret = Buffer.from(store.sessionSecret(() => assert.fail("no secret")));
  const payload = Buffer.from(JSON.stringify({ uid: id, exp: Date.now() + 60_000 })).toString(
    "base64url",
  );
  const legacy = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  assert.equal(auth.userFromHeader(bearer(legacy)).id, id);
  refused(() => auth.freshUserFromHeader(bearer(legacy)), "Please sign in again first, to confirm it's you.", "reauth");
  auth.signOutEverywhere(ann.user);
  for (const t of [legacy, ann.token, again.token]) {
    refused(() => auth.userFromHeader(bearer(t)), "session expired");
  }
  const after = await auth.authenticationOptions();
  const current = await auth.verifyAuthentication(after.flowId, phone.get(after.options) as any);
  console.log("ok: old tokens until sign out everywhere");

  // Recovery: the old passkey is gone and earlier sessions end, also after a
  // restart.
  const laptop = new SoftPasskey();
  const rec = await auth.recoveryOptions(ann.recoveryCode);
  const recovered = await auth.verifyRecovery(rec.flowId, laptop.create(rec.options) as any);
  refused(() => auth.userFromHeader(bearer(current.token)), "session expired");

  store = new Store(dir);
  auth = new PasskeyAuth(store);
  assert.equal(store.sessionVersion(id), 2);
  assert.deepEqual(
    store.passkeysOf(id).map((p) => p.id),
    [laptop.credentialId.toString("base64url")],
  );
  refused(() => auth.userFromHeader(bearer(current.token)), "session expired");
  assert.equal(auth.userFromHeader(bearer(recovered.token)).id, id);
  const old = await auth.authenticationOptions();
  await assert.rejects(
    auth.verifyAuthentication(old.flowId, phone.get(old.options) as any),
    (e) => e instanceof AuthError && e.message === "unknown passkey",
  );
  await assert.rejects(auth.recoveryOptions(ann.recoveryCode), AuthError);
  console.log("ok: recovery survives a restart");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
