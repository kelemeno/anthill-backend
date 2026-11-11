// Passkey (WebAuthn) sign-in. A passkey stands in for a wallet: registering one
// creates a user with a fresh 20-byte hex id, which is used in the tree exactly
// like an address was. Sessions are HMAC-signed bearer tokens carrying the
// user's session version: "sign out everywhere" and recovery bump it, which
// ends every earlier session (tokens from before versions existed count as 0).
//
// Signed-in users can add more passkeys (other devices). Each account also has a
// recovery code, shown once, which can register a new passkey if all devices
// are lost. Using it is single-use: it replaces the code, removes the account's
// other passkeys (the lost devices) and ends their sessions.
//
// Adding a passkey and replacing the recovery code need a recent sign-in, so a
// copied token alone can't turn into a lasting takeover.
//
// Config (env):
//   RP_ID          the site's domain the passkeys are bound to (default localhost)
//   RP_NAME        shown by the authenticator (default Anthill)
//   ORIGINS        comma-separated frontend origins allowed to sign in
//                  (default http://localhost:5173)
//   SESSION_SECRET HMAC key for session tokens (default: generated once and
//                  kept in the data dir)

import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Store, StoredPasskey, StoredUser } from "./store";

const rpID = process.env.RP_ID || "localhost";
const rpName = process.env.RP_NAME || "Anthill";
const origins = (process.env.ORIGINS || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o !== "");

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// how recent a sign-in must be for account changes
const FRESH_SIGN_IN_MS = 10 * 60 * 1000;

// `code` lets the frontend tell "sign in again first" from other refusals.
export class AuthError extends Error {
  constructor(
    message: string,
    readonly code?: "reauth",
  ) {
    super(message);
  }
}

// The checked contents of a session token.
type Session = { user: StoredUser; issuedAt: number };

type PendingChallenge = {
  challenge: string;
  expires: number;
  kind: "register" | "login" | "add" | "recover";
  // the account a new passkey is for (all kinds but login)
  user?: StoredUser;
  // recover: the hash of the code that opened it, which must still be current
  codeHash?: string;
};

export class PasskeyAuth {
  private pending = new Map<string, PendingChallenge>();
  private secret: Buffer;

  constructor(private store: Store) {
    this.secret = Buffer.from(
      process.env.SESSION_SECRET || store.sessionSecret(() => randomBytes(32).toString("hex")),
    );
  }

  async registrationOptions(name: string) {
    return this.newPasskeyOptions({ id: newUserId(), name }, "register");
  }

  // Creates the account. Returns the session and the account's recovery code,
  // which is shown to the user once.
  async verifyRegistration(flowId: string, response: RegistrationResponseJSON) {
    const pending = this.take(flowId, "register");
    const user = pending.user!;
    const passkey = await this.verifyNewPasskey(pending, response);
    this.store.addPasskey(user, passkey);
    return { ...this.session(user), recoveryCode: this.newRecoveryCode(user) };
  }

  // Another passkey for the signed-in user (e.g. a second device). Needs a
  // recent sign-in (see freshUserFromHeader).
  async addPasskeyOptions(user: StoredUser) {
    return this.newPasskeyOptions(user, "add");
  }

  async verifyAddPasskey(user: StoredUser, flowId: string, response: RegistrationResponseJSON) {
    const pending = this.take(flowId, "add");
    if (pending.user?.id !== user.id) {
      throw new AuthError("this passkey was started for another account");
    }
    this.store.addPasskeyToUser(await this.verifyNewPasskey(pending, response));
    return { ok: true };
  }

  // Lost every passkey: the recovery code lets you register a new one. The
  // flow remembers which code opened it, and only the newest flow per account
  // stays open.
  async recoveryOptions(code: string) {
    const codeHash = hashRecoveryCode(code);
    const user = this.store.userByRecoveryHash(codeHash);
    if (user === undefined) {
      throw new AuthError("That recovery code isn't valid.");
    }
    for (const [id, p] of this.pending) {
      if (p.kind === "recover" && p.user?.id === user.id) this.pending.delete(id);
    }
    const flow = await this.newPasskeyOptions(user, "recover");
    this.pending.get(flow.flowId)!.codeHash = codeHash;
    return flow;
  }

  // The new passkey replaces all the others (the lost or stolen devices),
  // every earlier session ends and the used code is replaced, in one log entry.
  async verifyRecovery(flowId: string, response: RegistrationResponseJSON) {
    const pending = this.take(flowId, "recover");
    const user = pending.user!;
    const passkey = await this.verifyNewPasskey(pending, response);
    // Checked after the await, with no await before the write: of flows opened
    // with the same code only one completes, and none after the code changed.
    if (this.store.recoveryHashOf(user.id) !== pending.codeHash) {
      throw new AuthError("That recovery code was already used or replaced.");
    }
    const code = newRecoveryCode();
    this.store.recover(user.id, passkey, hashRecoveryCode(code));
    return { ...this.session(user), recoveryCode: code };
  }

  // Ends every session of the user, this one included.
  signOutEverywhere(user: StoredUser) {
    this.store.signOutAll(user.id);
    return { ok: true };
  }

  // Issues a new recovery code for the user; the previous one stops working,
  // and so do recover flows it opened.
  newRecoveryCode(user: StoredUser): string {
    const code = newRecoveryCode();
    this.store.setRecoveryHash(user.id, hashRecoveryCode(code));
    return code;
  }

  private async newPasskeyOptions(user: StoredUser, kind: "register" | "add" | "recover") {
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: user.name,
      userID: new Uint8Array(Buffer.from(user.id.slice(2), "hex")),
      attestationType: "none",
      excludeCredentials: this.store
        .passkeysOf(user.id)
        .map((p) => ({ id: p.id, transports: p.transports })),
      // The verifier requires user verification (PIN or biometrics), so ask
      // for it: a key without a PIN is then asked to set one, instead of
      // failing after the ceremony.
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });
    return { flowId: this.remember(options.challenge, kind, user), options };
  }

  private async verifyNewPasskey(
    pending: PendingChallenge,
    response: RegistrationResponseJSON,
  ): Promise<StoredPasskey> {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: true,
    }).catch((e: Error) => {
      throw new AuthError(ceremonyError(e));
    });
    if (!verification.verified) {
      throw new AuthError("passkey not verified");
    }
    const { credential } = verification.registrationInfo;
    if (this.store.passkey(credential.id) !== undefined) {
      throw new AuthError("this passkey is already registered");
    }
    return {
      id: credential.id,
      userId: pending.user!.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: credential.transports,
    };
  }

  async authenticationOptions() {
    // No allowCredentials: the browser offers whichever passkey the user has
    // for this site (discoverable credentials).
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
    });
    return { flowId: this.remember(options.challenge, "login"), options };
  }

  async verifyAuthentication(flowId: string, response: AuthenticationResponseJSON) {
    const pending = this.take(flowId, "login");
    const passkey = this.store.passkey(response.id);
    if (passkey === undefined) {
      throw new AuthError("unknown passkey");
    }
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      credential: credentialOf(passkey),
      requireUserVerification: true,
    }).catch((e: Error) => {
      throw new AuthError(ceremonyError(e));
    });
    if (!verification.verified) {
      throw new AuthError("passkey not verified");
    }
    this.store.setPasskeyCounter(passkey.id, verification.authenticationInfo.newCounter);
    return this.session(this.store.user(passkey.userId)!);
  }

  // Returns the signed-in user for an `Authorization: Bearer <token>` header.
  userFromHeader(header: string | undefined): StoredUser {
    return this.sessionFromHeader(header).user;
  }

  // The same, for account changes: the token must come from a sign-in (or
  // sign-up, or recovery) in the last few minutes. Signing in again with a
  // passkey gives one.
  freshUserFromHeader(header: string | undefined): StoredUser {
    const { user, issuedAt } = this.sessionFromHeader(header);
    if (Date.now() - issuedAt > FRESH_SIGN_IN_MS) {
      throw new AuthError("Please sign in again first, to confirm it's you.", "reauth");
    }
    return user;
  }

  // Revoked tokens get "session expired" too, which the frontend treats as
  // signed out.
  private sessionFromHeader(header: string | undefined): Session {
    const token = header?.match(/^Bearer (.+)$/)?.[1];
    if (token === undefined) {
      throw new AuthError("not signed in");
    }
    const parts = token.split(".");
    if (parts.length !== 2) {
      throw new AuthError("bad session token");
    }
    const [payload, signature] = parts;
    if (!safeEqual(this.sign(payload), signature)) {
      throw new AuthError("bad session token");
    }
    let claims: { uid?: unknown; exp?: unknown; iat?: unknown; v?: unknown };
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    } catch {
      throw new AuthError("bad session token");
    }
    // tokens from before iat and v existed: issued long ago, version 0
    const { uid, exp, iat = 0, v = 0 } = claims ?? {};
    if (typeof uid !== "string" || typeof iat !== "number" || typeof v !== "number") {
      throw new AuthError("bad session token");
    }
    if (typeof exp !== "number" || exp < Date.now() || v !== this.store.sessionVersion(uid)) {
      throw new AuthError("session expired");
    }
    const user = this.store.user(uid);
    if (user === undefined) {
      throw new AuthError("unknown user");
    }
    return { user, issuedAt: iat };
  }

  private session(user: StoredUser) {
    const now = Date.now();
    const payload = Buffer.from(
      JSON.stringify({
        uid: user.id,
        iat: now,
        exp: now + SESSION_TTL_MS,
        v: this.store.sessionVersion(user.id),
      }),
    ).toString("base64url");
    return { token: `${payload}.${this.sign(payload)}`, user };
  }

  private sign(payload: string) {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  private remember(challenge: string, kind: PendingChallenge["kind"], user?: StoredUser) {
    const now = Date.now();
    for (const [id, p] of this.pending) {
      if (p.expires < now) this.pending.delete(id);
    }
    const flowId = randomUUID();
    this.pending.set(flowId, { challenge, kind, user, expires: now + CHALLENGE_TTL_MS });
    return flowId;
  }

  private take(flowId: string, kind: PendingChallenge["kind"]): PendingChallenge {
    const pending = this.pending.get(flowId);
    this.pending.delete(flowId);
    if (pending === undefined || pending.expires < Date.now() || pending.kind !== kind) {
      throw new AuthError("sign-in expired, try again");
    }
    return pending;
  }
}

// Constant-time string comparison that never throws: equal-length strings can
// still differ in byte length (non-ASCII), which timingSafeEqual rejects.
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// The library's message, or a plainer one where users will see it.
function ceremonyError(e: Error) {
  return /user verification/i.test(e.message)
    ? "Your passkey didn't confirm it's you (PIN, fingerprint or face). Set one up on the device and try again."
    : e.message;
}

function newUserId() {
  return `0x${randomBytes(20).toString("hex")}`;
}

// 120 random bits as six groups of four base32 characters, e.g.
// K7QM-2XPA-....
const BASE32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
function newRecoveryCode() {
  const bytes = randomBytes(24);
  const chars = Array.from(bytes, (b) => BASE32[b % 32]).join("");
  return chars.match(/.{4}/g)!.join("-");
}

function hashRecoveryCode(code: string) {
  const normalised = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return createHash("sha256").update(normalised).digest("hex");
}

function credentialOf(passkey: StoredPasskey) {
  return {
    id: passkey.id,
    publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")),
    counter: passkey.counter,
    transports: passkey.transports,
  };
}
