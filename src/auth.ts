// Passkey (WebAuthn) sign-in. A passkey stands in for a wallet: registering one
// creates a user with a fresh 20-byte hex id, which is used in the tree exactly
// like an address was. Sessions are HMAC-signed bearer tokens carrying the
// user's session version: "sign out everywhere" and recovery bump it, which
// ends every earlier session (tokens from before versions existed count as 0).
//
// Signed-in users can add more passkeys (other devices). Each account also has a
// recovery code, shown once, which can register a new passkey if all devices
// are lost. Using it is single-use: it replaces the code, removes the account's
// other passkeys (the lost devices), unlinks its Google account and ends every
// session: whatever someone holding a lost device could have added goes.
//
// Adding a passkey and replacing the recovery code need a recent sign-in, so a
// copied token alone can't turn into a lasting takeover.
//
// Google is another way in (google.ts proves who the person is; this file
// finds or makes their account). An account can have passkeys, a Google
// account, or both, and is never left with neither. Removing a passkey or
// unlinking Google also ends the sessions made with it (except the one doing
// it), so a lost device's passkey removed is that device signed out.
//
// Every sign-in is a session in the log, with an id (`sid`, in the token) and
// how it was made, so the account page can list them and end one. A token is
// valid while its signature and expiry check out, its session version is
// current and its session hasn't ended. Tokens from before sessions were
// logged have no sid: they keep working until sign out everywhere, like
// tokens from before versions.
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
import type { GoogleIdentity } from "./google";
import { ActionError, parseName } from "./offchain";
import type { SessionMethod, Store, StoredPasskey, StoredSession, StoredUser } from "./store";

const rpID = process.env.RP_ID || "localhost";
const rpName = process.env.RP_NAME || "Anthill";
// also where Google sign-in may return to (see google.ts)
export const origins = (process.env.ORIGINS || "http://localhost:5173")
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

// The checked contents of a session token. `sid` is missing on tokens from
// before sessions were logged.
type Session = { user: StoredUser; issuedAt: number; sid?: string };

// How a new session came about, as logged.
type SessionStart = { method: SessionMethod; device: string; passkey?: string };

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
  // which is shown to the user once. `device` labels the session (see
  // deviceLabel).
  async verifyRegistration(flowId: string, response: RegistrationResponseJSON, device = UNKNOWN_DEVICE) {
    const pending = this.take(flowId, "register");
    const user = pending.user!;
    const passkey = await this.verifyNewPasskey(pending, response);
    this.store.addPasskey(user, passkey);
    const recoveryCode = this.newRecoveryCode(user);
    return { ...this.session(user, { method: "register", device, passkey: passkey.id }), recoveryCode };
  }

  // Another passkey for the signed-in user (e.g. a second device). Needs a
  // recent sign-in (see freshUserFromHeader).
  async addPasskeyOptions(user: StoredUser) {
    return this.newPasskeyOptions(user, "add");
  }

  // For the session in `header`, which must still be open when the passkey is
  // added (not ended or signed out everywhere meanwhile, the account not
  // deleted): checked again after the await, with no await before the write.
  async verifyAddPasskey(header: string | undefined, flowId: string, response: RegistrationResponseJSON) {
    const { user } = this.sessionFromHeader(header);
    const pending = this.take(flowId, "add");
    if (pending.user?.id !== user.id) {
      throw new AuthError("this passkey was started for another account");
    }
    const passkey = await this.verifyNewPasskey(pending, response);
    this.sessionFromHeader(header);
    this.store.addPasskeyToUser(passkey);
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
  // every earlier session ends, the Google account is unlinked and the used
  // code is replaced, in one log entry. `googleUnlinked` names the Google
  // account that was linked, so the person can link it again if it's theirs:
  // its email, which is erased now (null when it wasn't known).
  async verifyRecovery(flowId: string, response: RegistrationResponseJSON, device = UNKNOWN_DEVICE) {
    const pending = this.take(flowId, "recover");
    const user = pending.user!;
    const passkey = await this.verifyNewPasskey(pending, response);
    // Checked after the await, with no await before the write: of flows opened
    // with the same code only one completes, and none after the code changed.
    if (this.store.recoveryHashOf(user.id) !== pending.codeHash) {
      throw new AuthError("That recovery code was already used or replaced.");
    }
    const code = newRecoveryCode();
    const google = this.store.googleOf(user.id);
    this.store.recover(user.id, passkey, hashRecoveryCode(code));
    return {
      ...this.session(user, { method: "recovery", device, passkey: passkey.id }),
      recoveryCode: code,
      ...(google === undefined ? {} : { googleUnlinked: { email: google.email ?? null } }),
    };
  }

  // Ends every session of the user, this one included.
  signOutEverywhere(user: StoredUser) {
    this.store.signOutAll(user.id);
    return { ok: true };
  }

  ////////////////////////////////////////////
  //// sessions, passkeys and sign-in methods, for the account page

  // The user's open sessions, newest first; `current` marks the caller's.
  sessions(header: string | undefined) {
    const { user, sid } = this.sessionFromHeader(header);
    return this.store.sessionsOf(user.id).map((s) => ({
      id: s.sid,
      method: s.method,
      device: s.device,
      createdAt: s.at,
      current: s.sid === sid,
    }));
  }

  // Ends one of the user's own sessions. No recent sign-in needed: ending a
  // session only ever protects the account.
  endSession(user: StoredUser, sid: string) {
    if (this.store.session(user.id, sid) === undefined) {
      throw new ActionError("That session has already ended.");
    }
    this.store.endSession(user.id, sid);
    return { ok: true };
  }

  // Signing out ends this session on the server too, so the token is dead
  // even if a copy of it is somewhere. (A token from before sessions were
  // logged has none to end; the page forgets it anyway.)
  signOut(header: string | undefined) {
    const { user, sid } = this.sessionFromHeader(header);
    if (sid !== undefined) this.store.endSession(user.id, sid);
    return { ok: true };
  }

  passkeys(user: StoredUser) {
    return this.store
      .passkeysOf(user.id)
      .map((p) => {
        const { addedAt, usedAt } = this.store.passkeyDates(p.id);
        return { id: p.id, createdAt: addedAt ?? "", lastUsedAt: usedAt, transports: p.transports ?? [] };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  // Needs a recent sign-in (see freshUserFromHeader). Refused when the
  // account would have no way left to sign in. The sessions made with the
  // passkey end too (a lost device signed out with it), all but the caller's.
  removePasskey(header: string | undefined, id: string) {
    const { user, sid } = this.freshSessionFromHeader(header);
    const passkey = this.store.passkey(id);
    if (passkey === undefined || passkey.userId !== user.id) {
      throw new ActionError("That passkey isn't on your account.");
    }
    if (this.store.passkeysOf(user.id).length === 1 && this.store.googleOf(user.id) === undefined) {
      throw new ActionError(
        "That's your only way to sign in. Add another passkey or link a Google account first.",
      );
    }
    const endedSessions = this.endSessionsWhere(user, sid, (s) => s.passkey === id);
    this.store.removePasskey(user.id, id);
    return { ok: true, endedSessions };
  }

  // Ends the user's open sessions that match, except `keep` (the caller's).
  // Before the change that called for it: if that write failed, the sessions
  // are still ended, and trying again ends no more than it should.
  private endSessionsWhere(user: StoredUser, keep: string | undefined, match: (s: StoredSession) => boolean) {
    const ending = this.store.sessionsOf(user.id).filter((s) => s.sid !== keep && match(s));
    for (const s of ending) this.store.endSession(user.id, s.sid);
    return ending.length;
  }

  // How the account signs in, for the account page (the email only ever goes
  // to the account holder; null when it isn't known, see store.ts).
  methods(user: StoredUser) {
    const google = this.store.googleOf(user.id);
    return {
      passkeys: this.store.passkeysOf(user.id).length,
      google: google === undefined ? null : { email: google.email ?? null },
      recoveryCode: this.store.recoveryHashOf(user.id) !== undefined,
    };
  }

  ////////////////////////////////////////////
  //// Google (google.ts checks who it is; this is about the account)

  // The Google account's Anthill account, or a new one. `beforeCreate` runs
  // only when an account is about to be made, and may refuse (the sign-up
  // limit). A Google account isn't given a recovery code: Google recovers it,
  // and one can be made later. The email Google reports is kept each time
  // (outside the log, see store.ts), so the account page shows the current one.
  googleSignIn(identity: GoogleIdentity, device: string, beforeCreate: () => void = () => {}) {
    const google = { sub: identity.sub, email: identity.email };
    const linked = this.store.userByGoogleSub(identity.sub);
    if (linked !== undefined) {
      this.store.googleEmailSeen(linked.id, identity.email);
      return { ...this.session(linked, { method: "google", device }), created: false };
    }
    beforeCreate();
    const user = { id: newUserId(), name: googleName(identity) };
    this.store.addGoogleUser(user, google);
    return { ...this.session(user, { method: "google", device }), created: true };
  }

  // A Google-only account confirming it's you (it has no passkey to sign in
  // again with): the Google account must be the one linked to `user`, and
  // nothing is ever made for another. Answers a new session, which is fresh,
  // and ends `startedBy`, the session that started the flow, so confirming
  // doesn't leave it behind.
  confirmWithGoogle(user: StoredUser, startedBy: string | undefined, identity: GoogleIdentity, device: string) {
    const linked = this.store.googleOf(user.id);
    if (linked === undefined) throw new ActionError("No Google account is linked to yours.");
    if (linked.sub !== identity.sub) {
      throw new ActionError("That's a different Google account from the one linked to your Anthill account.");
    }
    this.store.googleEmailSeen(user.id, identity.email);
    const confirmed = this.session(user, { method: "google", device });
    if (startedBy !== undefined && this.store.session(user.id, startedBy) !== undefined) {
      this.store.endSession(user.id, startedBy);
    }
    return confirmed;
  }

  // One Google account per Anthill account (unlink it first to change it),
  // and one Anthill account per Google account. Linking it again only
  // updates its email.
  linkGoogle(user: StoredUser, identity: GoogleIdentity) {
    const owner = this.store.userByGoogleSub(identity.sub);
    if (owner !== undefined && owner.id !== user.id) {
      throw new ActionError("That Google account is already linked to another Anthill account.");
    }
    const current = this.store.googleOf(user.id);
    if (current !== undefined && current.sub !== identity.sub) {
      throw new ActionError("Your account is already linked to another Google account. Unlink it first.");
    }
    if (current === undefined) this.store.linkGoogle(user.id, { sub: identity.sub, email: identity.email });
    else this.store.googleEmailSeen(user.id, identity.email);
    return { google: { email: identity.email || null } };
  }

  // Needs a recent sign-in. A passkey must be left to sign in with. The
  // sessions made with Google end too, all but the caller's. The email is
  // erased; Google's id for the account stays in the log.
  unlinkGoogle(header: string | undefined) {
    const { user, sid } = this.freshSessionFromHeader(header);
    if (this.store.googleOf(user.id) === undefined) {
      throw new ActionError("No Google account is linked to yours.");
    }
    if (this.store.passkeysOf(user.id).length === 0) {
      throw new ActionError("Add a passkey first, or you'd have no way to sign in.");
    }
    const endedSessions = this.endSessionsWhere(user, sid, (s) => s.method === "google");
    this.store.unlinkGoogle(user.id);
    return { ok: true, endedSessions };
  }

  // A session for whoever just proved who they are another way (Google).
  newSession(user: StoredUser, start: SessionStart) {
    return this.session(user, start);
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

  async verifyAuthentication(flowId: string, response: AuthenticationResponseJSON, device = UNKNOWN_DEVICE) {
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
    // Checked again after the await, with no await before the writes: a
    // passkey removed (a stolen device's) or an account deleted meanwhile
    // signs nobody in.
    const current = this.store.passkey(passkey.id);
    if (current === undefined || current.userId !== passkey.userId || this.store.isDeleted(passkey.userId)) {
      throw new AuthError("unknown passkey");
    }
    this.store.setPasskeyCounter(passkey.id, verification.authenticationInfo.newCounter);
    return this.session(this.store.user(passkey.userId)!, { method: "passkey", device, passkey: passkey.id });
  }

  // Returns the signed-in user for an `Authorization: Bearer <token>` header.
  userFromHeader(header: string | undefined): StoredUser {
    return this.sessionFromHeader(header).user;
  }

  // The same, for account changes: the token must come from a sign-in (or
  // sign-up, or recovery) in the last few minutes. Signing in again with a
  // passkey gives one, or, for an account without passkeys, confirming with
  // Google (confirmWithGoogle).
  freshUserFromHeader(header: string | undefined): StoredUser {
    return this.freshSessionFromHeader(header).user;
  }

  // The signed-in user and their session's id (none for tokens from before
  // sessions were logged).
  currentSession(header: string | undefined): { user: StoredUser; sid?: string } {
    const { user, sid } = this.sessionFromHeader(header);
    return { user, sid };
  }

  private freshSessionFromHeader(header: string | undefined): Session {
    const session = this.sessionFromHeader(header);
    if (Date.now() - session.issuedAt > FRESH_SIGN_IN_MS) {
      throw new AuthError("Please sign in again first, to confirm it's you.", "reauth");
    }
    return session;
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
    let claims: { uid?: unknown; exp?: unknown; iat?: unknown; v?: unknown; sid?: unknown };
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    } catch {
      throw new AuthError("bad session token");
    }
    // tokens from before iat and v existed: issued long ago, version 0
    // and from before sessions were logged: no sid
    const { uid, exp, iat = 0, v = 0, sid } = claims ?? {};
    if (
      typeof uid !== "string" ||
      typeof iat !== "number" ||
      typeof v !== "number" ||
      (sid !== undefined && typeof sid !== "string")
    ) {
      throw new AuthError("bad session token");
    }
    if (
      typeof exp !== "number" ||
      exp < Date.now() ||
      v !== this.store.sessionVersion(uid) ||
      (sid !== undefined && this.store.session(uid, sid) === undefined) ||
      this.store.isDeleted(uid)
    ) {
      throw new AuthError("session expired");
    }
    const user = this.store.user(uid);
    if (user === undefined) {
      throw new AuthError("unknown user");
    }
    return { user, issuedAt: iat, sid };
  }

  // A new session, logged before its token exists. The token says how it was
  // made (`m`), so later kinds of token (one scoped to a community's app,
  // say) can be told apart by the same field.
  private session(user: StoredUser, start: SessionStart) {
    const now = Date.now();
    const sid = randomBytes(16).toString("base64url");
    const exp = now + SESSION_TTL_MS;
    this.store.startSession({
      sid,
      userId: user.id,
      method: start.method,
      device: start.device,
      expires: new Date(exp).toISOString(),
      ...(start.passkey === undefined ? {} : { passkey: start.passkey }),
    });
    const payload = Buffer.from(
      JSON.stringify({
        uid: user.id,
        iat: now,
        exp,
        v: this.store.sessionVersion(user.id),
        sid,
        m: start.method,
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

// A new Google account's name: the first name Google gives (less public than
// the full one), cleaned like any name, else the full name, else a stand-in
// the person can change.
function googleName(identity: GoogleIdentity) {
  for (const candidate of [identity.givenName, identity.name]) {
    try {
      return parseName(candidate);
    } catch {
      // missing, blank or too long: the next one
    }
  }
  return "New member";
}

const UNKNOWN_DEVICE = "Unknown device";

// A coarse label for the session list, e.g. "Chrome on macOS": enough to
// tell your devices apart, not to identify one.
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const browser = /\bEdg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /\b(OPR|Opera)\//.test(ua)
      ? "Opera"
      : /\bSamsungBrowser\//.test(ua)
        ? "Samsung Internet"
        : /\b(Firefox|FxiOS)\//.test(ua)
          ? "Firefox"
          : /\b(Chrome|CriOS|Chromium)\//.test(ua)
            ? "Chrome"
            : /\bSafari\//.test(ua) && /\bVersion\//.test(ua)
              ? "Safari"
              : undefined;
  const os = /\biPad\b/.test(ua)
    ? "iPadOS"
    : /\b(iPhone|iPod)\b/.test(ua)
      ? "iOS"
      : /\bAndroid\b/.test(ua)
        ? "Android"
        : /\bCrOS\b/.test(ua)
          ? "ChromeOS"
          : /\bMac OS X\b|\bMacintosh\b/.test(ua)
            ? "macOS"
            : /\bWindows\b/.test(ua)
              ? "Windows"
              : /\bLinux\b/.test(ua)
                ? "Linux"
                : undefined;
  if (browser !== undefined && os !== undefined) return `${browser} on ${os}`;
  return browser ?? os ?? UNKNOWN_DEVICE;
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
