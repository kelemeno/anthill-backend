// Passkey (WebAuthn) sign-in. A passkey stands in for a wallet: registering one
// creates a user with a fresh 20-byte hex id, which is used in the tree exactly
// like an address was. Sessions are stateless HMAC-signed bearer tokens.
//
// Signed-in users can add more passkeys (other devices). Each account also has a
// recovery code, shown once, which can register a new passkey if all devices
// are lost; using it issues a fresh code.
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

export class AuthError extends Error {}

type PendingChallenge = {
  challenge: string;
  expires: number;
  kind: "register" | "login" | "add" | "recover";
  // the account a new passkey is for (all kinds but login)
  user?: StoredUser;
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

  // Another passkey for the signed-in user (e.g. a second device).
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

  // Lost every passkey: the recovery code lets you register a new one.
  async recoveryOptions(code: string) {
    const user = this.store.userByRecoveryHash(hashRecoveryCode(code));
    if (user === undefined) {
      throw new AuthError("That recovery code isn't valid.");
    }
    return this.newPasskeyOptions(user, "recover");
  }

  async verifyRecovery(flowId: string, response: RegistrationResponseJSON) {
    const pending = this.take(flowId, "recover");
    const user = pending.user!;
    this.store.addPasskeyToUser(await this.verifyNewPasskey(pending, response));
    // the used code is replaced
    return { ...this.session(user), recoveryCode: this.newRecoveryCode(user) };
  }

  // Issues a new recovery code for the user; the previous one stops working.
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
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "preferred",
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
    }).catch((e: Error) => {
      throw new AuthError(e.message);
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
      userVerification: "preferred",
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
    }).catch((e: Error) => {
      throw new AuthError(e.message);
    });
    if (!verification.verified) {
      throw new AuthError("passkey not verified");
    }
    this.store.setPasskeyCounter(passkey.id, verification.authenticationInfo.newCounter);
    return this.session(this.store.user(passkey.userId)!);
  }

  // Returns the signed-in user for an `Authorization: Bearer <token>` header.
  userFromHeader(header: string | undefined): StoredUser {
    const token = header?.match(/^Bearer (.+)$/)?.[1];
    if (token === undefined) {
      throw new AuthError("not signed in");
    }
    const [payload, signature] = token.split(".");
    if (payload === undefined || signature === undefined) {
      throw new AuthError("bad session token");
    }
    const expected = this.sign(payload);
    if (
      expected.length !== signature.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    ) {
      throw new AuthError("bad session token");
    }
    const { uid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof exp !== "number" || exp < Date.now()) {
      throw new AuthError("session expired");
    }
    const user = this.store.user(uid);
    if (user === undefined) {
      throw new AuthError("unknown user");
    }
    return user;
  }

  private session(user: StoredUser) {
    const payload = Buffer.from(
      JSON.stringify({ uid: user.id, exp: Date.now() + SESSION_TTL_MS }),
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
