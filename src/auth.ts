// Passkey (WebAuthn) sign-in. A passkey stands in for a wallet: registering one
// creates a user with a fresh 20-byte hex id, which is used in the tree exactly
// like an address was. Sessions are stateless HMAC-signed bearer tokens.
//
// Config (env):
//   RP_ID          the site's domain the passkeys are bound to (default localhost)
//   RP_NAME        shown by the authenticator (default Anthill)
//   ORIGINS        comma-separated frontend origins allowed to sign in
//                  (default http://localhost:5173)
//   SESSION_SECRET HMAC key for session tokens (default: generated once and
//                  kept in the data dir)

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
  // set for registrations
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
    const user: StoredUser = { id: newUserId(), name };
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: name,
      userID: new Uint8Array(Buffer.from(user.id.slice(2), "hex")),
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "preferred",
      },
    });
    return { flowId: this.remember(options.challenge, user), options };
  }

  async verifyRegistration(flowId: string, response: RegistrationResponseJSON) {
    const pending = this.take(flowId);
    const user = pending.user;
    if (user === undefined) {
      throw new AuthError("not a registration");
    }
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
    this.store.addPasskey(user, {
      id: credential.id,
      userId: user.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: credential.transports,
    });
    return this.session(user);
  }

  async authenticationOptions() {
    // No allowCredentials: the browser offers whichever passkey the user has
    // for this site (discoverable credentials).
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "preferred",
    });
    return { flowId: this.remember(options.challenge), options };
  }

  async verifyAuthentication(flowId: string, response: AuthenticationResponseJSON) {
    const pending = this.take(flowId);
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

  private remember(challenge: string, user?: StoredUser) {
    const now = Date.now();
    for (const [id, p] of this.pending) {
      if (p.expires < now) this.pending.delete(id);
    }
    const flowId = randomUUID();
    this.pending.set(flowId, { challenge, user, expires: now + CHALLENGE_TTL_MS });
    return flowId;
  }

  private take(flowId: string): PendingChallenge {
    const pending = this.pending.get(flowId);
    this.pending.delete(flowId);
    if (pending === undefined || pending.expires < Date.now()) {
      throw new AuthError("sign-in expired, try again");
    }
    return pending;
  }
}

function newUserId() {
  return `0x${randomBytes(20).toString("hex")}`;
}

function credentialOf(passkey: StoredPasskey) {
  return {
    id: passkey.id,
    publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")),
    counter: passkey.counter,
    transports: passkey.transports,
  };
}
