// Google sign-in: OpenID Connect's authorization code flow with PKCE, with
// this server as a confidential client. No Google script runs on our pages:
// the frontend sends the person to Google's page and back to its own
// /auth/google, which hands the code to us. We swap it for an id_token at
// Google's token endpoint (with the client secret and the PKCE verifier) and
// check that token ourselves anyway: its RS256 signature against Google's
// published keys, its issuer, audience, expiry and the nonce we sent. Then
// auth.ts finds or makes the account.
//
// Google is one way into an Anthill account, never what it depends on: it
// can always have passkeys too, and membership lives here.
//
// Config (env): GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, from an OAuth
// client of type "Web application" whose authorised redirect URIs are each
// ORIGINS entry + /auth/google. Without them Google sign-in is off.
//
// A flow keeps no state here while the person is at Google: its state, nonce,
// PKCE verifier, redirect URI, intent and account are sealed (AES-256-GCM,
// with a key from the session secret) into the `state` Google hands back. So
// nobody can crowd out someone else's flow by starting many (a map of pending
// flows has to forget some when it's full, and starting needs no sign-in),
// and the verifier and nonce never show in a URL. A state works for 10
// minutes, and once: a finished one is remembered until it expires (only
// finished ones, which need a real Google sign-in each). A restart forgets
// those, but Google takes each code only once anyway.
//
// The endpoints and fetch can be swapped, so the checks run against a fake
// Google (scripts/accountChecks.ts).

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  type KeyObject,
  randomBytes,
  verify,
} from "node:crypto";
import { AuthError, origins } from "./auth";
import { ActionError } from "./offchain";

export const GOOGLE_ENDPOINTS = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
};
// Google writes its issuer both ways
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

const FLOW_TTL_MS = 10 * 60 * 1000;
// longer than any state we make (about 500 characters)
const MAX_STATE_LENGTH = 2048;
// what a sealed state is bound to, so no other sealed blob passes for one
const STATE_AAD = Buffer.from("anthill google flow v1");
// clock difference allowed when checking the token's expiry
const CLOCK_SKEW_MS = 60_000;
// how long Google's keys are kept when its answer doesn't say (and the most)
const DEFAULT_KEYS_TTL_MS = 60 * 60 * 1000;
const MAX_KEYS_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export type GoogleOptions = {
  clientId?: string;
  clientSecret?: string;
  endpoints?: Partial<typeof GOOGLE_ENDPOINTS>;
  fetch?: typeof fetch;
};

// signin: sign in or make an account. link: add Google to the signed-in
// account. confirm: a Google-only account confirming it's you (a fresh
// session) with its linked Google account, which never makes an account.
export type GoogleIntent = "signin" | "link" | "confirm";

// The signed-in account a link or confirm flow is for, and (confirm) the
// session that started it and the linked email, to preselect at Google.
export type GoogleFlowAccount = { user: string; sid?: string; loginHint?: string };

// Who Google says the person is.
export type GoogleIdentity = { sub: string; email: string; givenName?: string; name?: string };

// What a state holds (sealed).
type Flow = {
  nonce: string;
  verifier: string;
  redirectUri: string;
  intent: GoogleIntent;
  // link and confirm: the account it's for, and the session that started it
  user?: string;
  sid?: string;
  expires: number;
};

// Shown for any id_token that doesn't check out: what exactly failed is
// logged, not told.
const NOT_VERIFIED = "Google's answer couldn't be verified. Try again.";

const b64url = (bytes: Buffer) => bytes.toString("base64url");

export class GoogleSignIn {
  // hash of a finished state -> when it expires
  private finished = new Map<string, number>();
  private stateKey: Buffer;
  private clientId: string;
  private clientSecret: string;
  private endpoints: typeof GOOGLE_ENDPOINTS;
  private fetch: typeof fetch;
  private keys: { byId: Map<string, KeyObject>; expires: number } | undefined;
  private loadingKeys: Promise<void> | undefined;

  // `secret`: the server's session secret, which the states' key comes from.
  constructor(secret: string | Buffer, options: GoogleOptions = {}) {
    this.stateKey = createHmac("sha256", secret).update("google-flow-key").digest();
    this.clientId = options.clientId ?? process.env.GOOGLE_CLIENT_ID ?? "";
    this.clientSecret = options.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET ?? "";
    this.endpoints = { ...GOOGLE_ENDPOINTS, ...options.endpoints };
    // (called through a wrapper: some fetches refuse to run with another `this`)
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get enabled() {
    return this.clientId !== "" && this.clientSecret !== "";
  }

  // The Google page to send the person to. `origin` is the frontend's (one of
  // ORIGINS), which Google sends them back to; for "link" and "confirm",
  // `account` is the signed-in one. The state is the flow (see the top), and
  // the page keeps it to check that the answer is to a flow it started.
  start(intent: unknown, origin: unknown, account?: GoogleFlowAccount) {
    if (!this.enabled) throw new ActionError("Google sign-in isn't set up on this server.");
    if (intent !== "signin" && intent !== "link" && intent !== "confirm") {
      throw new ActionError('intent must be "signin", "link" or "confirm"');
    }
    if (typeof origin !== "string" || !origins.includes(origin)) {
      throw new ActionError("Google sign-in isn't allowed from this site.");
    }
    if ((intent === "signin") !== (account === undefined)) {
      throw new Error(`google: a ${intent} flow ${account === undefined ? "needs" : "takes no"} account`);
    }
    const flow: Flow = {
      nonce: b64url(randomBytes(32)),
      verifier: b64url(randomBytes(32)),
      redirectUri: `${origin}/auth/google`,
      intent,
      user: account?.user,
      sid: account?.sid,
      expires: Date.now() + FLOW_TTL_MS,
    };
    const state = this.seal(flow);
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: flow.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce: flow.nonce,
      code_challenge: b64url(createHash("sha256").update(flow.verifier).digest()),
      code_challenge_method: "S256",
      prompt: "select_account",
      ...(account?.loginHint ? { login_hint: account.loginHint } : {}),
    });
    return { url: `${this.endpoints.authorize}?${params}`, state };
  }

  // Finishes a flow (once) and returns who the person is, with what the flow
  // was for.
  async finish(state: unknown, code: unknown) {
    if (typeof state !== "string" || typeof code !== "string" || code === "" || code.length > 2048) {
      throw new ActionError("expected a state and a code");
    }
    const now = Date.now();
    for (const [hash, expires] of this.finished) if (expires < now) this.finished.delete(hash);
    const flow = this.unseal(state);
    const hash = createHash("sha256").update(state).digest("base64url");
    if (flow === undefined || flow.expires < now || this.finished.has(hash)) {
      throw new AuthError("Google sign-in expired, try again.");
    }
    const idToken = await this.exchange(flow, code);
    const identity = await this.verifyIdToken(idToken, flow.nonce);
    // after the awaits, with none before the check: of two finishes with the
    // same state only one gets here (Google takes a code once, too)
    if (this.finished.has(hash)) throw new AuthError("Google sign-in expired, try again.");
    this.finished.set(hash, flow.expires);
    return { intent: flow.intent, user: flow.user, sid: flow.sid, identity };
  }

  // A flow sealed into a state: a random IV, then the encrypted JSON and the
  // GCM tag, base64url.
  private seal(flow: Flow): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.stateKey, iv);
    cipher.setAAD(STATE_AAD);
    const sealed = Buffer.concat([cipher.update(JSON.stringify(flow), "utf8"), cipher.final()]);
    return b64url(Buffer.concat([iv, sealed, cipher.getAuthTag()]));
  }

  // The flow in a state, or undefined for anything we didn't seal (or that
  // was changed since).
  private unseal(state: string): Flow | undefined {
    if (state.length > MAX_STATE_LENGTH) return undefined;
    const raw = Buffer.from(state, "base64url");
    // exactly as we wrote it: the decoder skips stray characters, and a
    // state spelt another way would be another state to the used-once check
    if (raw.length < 12 + 16 + 2 || b64url(raw) !== state) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.stateKey, raw.subarray(0, 12));
      decipher.setAAD(STATE_AAD);
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      const json = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
      const flow = JSON.parse(json.toString("utf8")) as Flow;
      return typeof flow?.nonce === "string" && typeof flow.expires === "number" ? flow : undefined;
    } catch {
      return undefined;
    }
  }

  // The code for tokens, at Google's token endpoint. Only the id_token is
  // used: we never call Google on the person's behalf.
  private async exchange(flow: Flow, code: string): Promise<string> {
    let answer: { id_token?: unknown; error?: unknown };
    try {
      const res = await this.fetch(this.endpoints.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: flow.redirectUri,
          code_verifier: flow.verifier,
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      answer = (await res.json().catch(() => ({}))) as typeof answer;
      if (!res.ok) {
        console.warn("google: the token endpoint said", res.status, String(answer?.error ?? ""));
        throw new AuthError("Google didn't confirm the sign-in. Try again.");
      }
    } catch (e) {
      if (e instanceof AuthError) throw e;
      console.warn("google: the token endpoint couldn't be reached:", String(e));
      throw new AuthError("Couldn't reach Google. Try again in a moment.");
    }
    if (typeof answer?.id_token !== "string") {
      console.warn("google: no id_token in the token endpoint's answer");
      throw new AuthError("Google didn't confirm the sign-in. Try again.");
    }
    return answer.id_token;
  }

  private async verifyIdToken(token: string, nonce: string): Promise<GoogleIdentity> {
    const refuse = (why: string): never => {
      console.warn("google: id_token refused:", why);
      throw new AuthError(NOT_VERIFIED);
    };
    const parts = token.split(".");
    if (parts.length !== 3) refuse("not a JWT");
    const [headerPart, claimsPart, signaturePart] = parts;
    const header = parseJson(headerPart);
    if (header?.alg !== "RS256" || typeof header.kid !== "string") refuse(`alg ${header?.alg}`);
    const key = await this.key(header.kid);
    if (key === undefined) refuse("unknown key id");
    const signed = verify(
      "RSA-SHA256",
      Buffer.from(`${headerPart}.${claimsPart}`),
      key!,
      Buffer.from(signaturePart, "base64url"),
    );
    if (!signed) refuse("bad signature");
    const claims = parseJson(claimsPart);
    if (claims === undefined) refuse("unreadable claims");
    if (!ISSUERS.has(claims.iss)) refuse("issuer");
    // a single audience, as Google sends it; several only with us as azp
    const aud = claims.aud;
    const forUs =
      aud === this.clientId ||
      (Array.isArray(aud) && aud.includes(this.clientId) && claims.azp === this.clientId);
    if (!forUs) refuse("audience");
    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - CLOCK_SKEW_MS) refuse("expired");
    if (typeof claims.nonce !== "string" || claims.nonce !== nonce) refuse("nonce");
    if (typeof claims.sub !== "string" || claims.sub === "" || claims.sub.length > 255) refuse("no sub");
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    return {
      sub: claims.sub,
      email: text(claims.email) ?? "",
      givenName: text(claims.given_name),
      name: text(claims.name),
    };
  }

  // Google's key with this id: the cached keys while they're fresh (as long
  // as Google's Cache-Control says), refetched once for an id they lack (a
  // key Google started using since). Only Google's token endpoint hands us
  // tokens, so an unknown id can't be used to make us fetch at will.
  private async key(kid: string): Promise<KeyObject | undefined> {
    let fetched = false;
    if (this.keys === undefined || this.keys.expires < Date.now()) {
      await this.loadKeys();
      fetched = true;
    }
    let key = this.keys?.byId.get(kid);
    if (key === undefined && !fetched) {
      await this.loadKeys();
      key = this.keys?.byId.get(kid);
    }
    return key;
  }

  // One fetch at a time; requests arriving meanwhile wait for it.
  private loadKeys(): Promise<void> {
    this.loadingKeys ??= this.fetchKeys().finally(() => {
      this.loadingKeys = undefined;
    });
    return this.loadingKeys;
  }

  private async fetchKeys() {
    let body: { keys?: unknown };
    let maxAge: number | undefined;
    try {
      const res = await this.fetch(this.endpoints.jwks, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      body = (await res.json()) as typeof body;
      const age = res.headers.get("Cache-Control")?.match(/max-age=(\d+)/)?.[1];
      maxAge = age === undefined ? undefined : Number(age) * 1000;
    } catch (e) {
      console.warn("google: couldn't fetch its keys:", String(e));
      throw new AuthError("Couldn't reach Google. Try again in a moment.");
    }
    const byId = new Map<string, KeyObject>();
    for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
      if (jwk?.kty !== "RSA" || typeof jwk.kid !== "string") continue;
      if ((jwk.alg !== undefined && jwk.alg !== "RS256") || (jwk.use !== undefined && jwk.use !== "sig")) continue;
      try {
        byId.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
      } catch {
        // not a usable RSA key: skipped
      }
    }
    const ttl = Math.min(MAX_KEYS_TTL_MS, maxAge ?? DEFAULT_KEYS_TTL_MS);
    this.keys = { byId, expires: Date.now() + ttl };
  }
}

// A JWT part's JSON object, or undefined.
function parseJson(part: string): any {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
