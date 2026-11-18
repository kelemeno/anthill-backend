// Checks of accounts, run in-process on throwaway data dirs (no server
// needed): Google sign-in against a fake Google (its own RSA key, JWKS and
// token endpoint), refusing id_tokens with a bad signature, another audience
// or issuer, an expired one, the wrong nonce, a replayed, changed or expired
// state, and no flood of starts crowding out a flow; linking and unlinking
// (one Google account per account and back, its sessions ending); a
// Google-only account confirming it's you (only with its own Google account,
// never making one); recovery unlinking Google; sessions listed, ended and
// signed out, also after a restart; passkeys listed and removed (never the
// last way in, their sessions ending, not signing in while being removed);
// the export (everything about you with the polls you voted in, no keys,
// nothing private about anyone else, limited per IP and one at a time);
// deleting an account (it leaves every tree, as a root with children too,
// can't sign in again, also after a restart, nothing is written for it by
// requests still under way, an old uncleaned name still confirms, and its
// founderless communities are run by their root); an invite link's preview
// of a private community; CORS, security headers and caching on real Hono
// requests. Throughout, the Google email never reaches the log: it's in its
// side file, updated on each sign-in, erased on unlink, recovery and
// deletion, kept across a restart, and a missing, unreadable or stale side
// file is handled.
//
//   npx tsx scripts/accountChecks.ts

import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { GoogleOptions } from "../src/google";
import { SoftPasskey } from "./softPasskey";

// before the modules that read them are loaded
process.env.RP_ID = "localhost";
process.env.ORIGINS = "http://localhost:5173";
process.env.SEED = "empty";
delete process.env.SESSION_SECRET;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

const ORIGIN = "http://localhost:5173";
const CLIENT_ID = "anthill-test.apps.googleusercontent.com";
const CLIENT_SECRET = "fake-client-secret";
const ENDPOINTS = {
  authorize: "https://google.test/o/oauth2/v2/auth",
  token: "https://google.test/token",
  jwks: "https://google.test/certs",
};
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

const ok = (name: string) => console.log(`ok: ${name}`);

// Holds the next WebCrypto call of this kind (the passkey library's
// signature check or hash) until released: to land another request in the
// middle of a passkey ceremony, after its first look at the store.
function holdNext(method: "verify" | "digest") {
  const subtle = globalThis.crypto.subtle as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const real = subtle[method];
  let reached!: () => void;
  let release!: () => void;
  const atIt = new Promise<void>((resolve) => (reached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  subtle[method] = async (...args: unknown[]) => {
    delete subtle[method];
    reached();
    await released;
    return real.apply(globalThis.crypto.subtle, args);
  };
  return { atIt, release };
}
const b64url = (x: Buffer | string) => Buffer.from(x).toString("base64url");
const realNow = Date.now;
const later = (ms: number) => {
  Date.now = () => realNow() + ms;
};

// Google as far as we talk to it: the page (consent() stands in for the
// person picking their account there), the token endpoint and the keys.
class FakeGoogle {
  private key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  kid = "fake-1";
  // a key Google never published
  readonly stranger = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  jwksFetches = 0;
  private codes = new Map<string, { challenge: string; redirectUri: string; idToken: string }>();

  get privateKey() {
    return this.key.privateKey;
  }

  // Google starts signing with a new key (and publishes only that one).
  rotate() {
    this.key = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.kid = `fake-${randomBytes(3).toString("hex")}`;
  }

  // What Google sends back to the redirect URI after the person agreed: a
  // code for an id_token with these claims (undefined drops one).
  consent(url: string, claims: Record<string, unknown>, signer: { key?: KeyObject; kid?: string } = {}) {
    const params = new URL(url).searchParams;
    assert.equal(params.get("client_id"), CLIENT_ID);
    assert.equal(params.get("response_type"), "code");
    assert.equal(params.get("scope"), "openid email profile");
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.equal(params.get("prompt"), "select_account");
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      iat: now,
      exp: now + 3600,
      nonce: params.get("nonce"),
      ...claims,
    };
    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
    const header = b64url(JSON.stringify({ alg: "RS256", kid: signer.kid ?? this.kid, typ: "JWT" }));
    const body = b64url(JSON.stringify(payload));
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), signer.key ?? this.key.privateKey);
    const code = randomBytes(12).toString("base64url");
    this.codes.set(code, {
      challenge: params.get("code_challenge")!,
      redirectUri: params.get("redirect_uri")!,
      idToken: `${header}.${body}.${b64url(signature)}`,
    });
    return { state: params.get("state")!, code };
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === ENDPOINTS.jwks) {
      this.jwksFetches += 1;
      const jwk = { ...this.key.publicKey.export({ format: "jwk" }), kid: this.kid, alg: "RS256", use: "sig" };
      return Response.json({ keys: [jwk] }, { headers: { "Cache-Control": "public, max-age=3600" } });
    }
    if (url === ENDPOINTS.token) {
      const form = new URLSearchParams(String(init?.body));
      const issued = this.codes.get(form.get("code") ?? "");
      this.codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const good =
        issued !== undefined &&
        form.get("grant_type") === "authorization_code" &&
        form.get("client_id") === CLIENT_ID &&
        form.get("client_secret") === CLIENT_SECRET &&
        form.get("redirect_uri") === issued.redirectUri &&
        b64url(createHash("sha256").update(verifier).digest()) === issued.challenge;
      if (!good) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: "unused", token_type: "Bearer", expires_in: 3599, id_token: issued.idToken });
    }
    return new Response("not found", { status: 404 });
  };
}

async function main() {
  const { offchainServer } = await import("../src/offchainApi");
  const { GoogleSignIn } = await import("../src/google");
  const { AuthError, origins } = await import("../src/auth");
  const { corsPolicy, securityHeaders } = await import("../src/headers");
  const { NotFoundError, RateLimitError } = await import("../src/http");
  const { ActionError } = await import("../src/offchain");
  const { Store } = await import("../src/store");

  const google = new FakeGoogle();
  const googleOptions: GoogleOptions = {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    endpoints: ENDPOINTS,
    fetch: google.fetch,
  };

  // A server on `dir`, set up as App.ts does (headers, CORS, errors).
  async function boot(dir: string, options: { google?: GoogleOptions } = { google: googleOptions }) {
    process.env.DATA_DIR = dir;
    const app = new Hono();
    app.use("*", securityHeaders());
    app.use("*", corsPolicy(origins));
    app.onError((err, c) => {
      if (err instanceof AuthError) return c.json({ error: err.message, code: err.code }, 401);
      if (err instanceof ActionError) return c.json({ error: err.message, code: err.code }, 400);
      if (err instanceof NotFoundError) return c.json({ error: "Not found" }, 404);
      if (err instanceof RateLimitError) return c.json({ error: "rate limited" }, 429);
      console.error(err);
      return c.json({ error: "internal error" }, 500);
    });
    const { start } = offchainServer(app, () => {}, options);
    await start();
    const call = async (path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
      const res = await app.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data: any = text;
      try {
        data = JSON.parse(text);
      } catch {
        // not JSON
      }
      return { status: res.status, headers: res.headers, data, text };
    };
    return { app, call };
  }
  type Server = Awaited<ReturnType<typeof boot>>;

  const expect = (res: { status: number; data: any }, status: number, error?: string) => {
    assert.equal(res.status, status, JSON.stringify(res.data));
    if (error !== undefined) assert.equal(res.data.error, error);
    return res.data;
  };

  async function register(server: Server, name: string, ua = SAFARI_MAC) {
    const passkey = new SoftPasskey();
    const options = await server.call("/auth/register/options", { name });
    const verified = await server.call(
      "/auth/register/verify",
      { flowId: options.data.flowId, response: passkey.create(options.data.options) },
      undefined,
      { "User-Agent": ua },
    );
    const data = expect(verified, 200);
    return { ...(data as { token: string; user: { id: string; name: string }; recoveryCode: string }), passkey };
  }

  async function signIn(server: Server, passkey: SoftPasskey, ua = SAFARI_MAC) {
    const options = await server.call("/auth/login/options", {});
    return server.call(
      "/auth/login/verify",
      { flowId: options.data.flowId, response: passkey.get(options.data.options) },
      undefined,
      { "User-Agent": ua },
    );
  }

  // Start, consent at the fake Google, finish: the finish's answer.
  async function viaGoogle(
    server: Server,
    claims: Record<string, unknown>,
    options: { intent?: "signin" | "link" | "confirm"; token?: string; signer?: { key?: KeyObject; kid?: string } } = {},
  ) {
    const started = await server.call("/auth/google/start", { intent: options.intent ?? "signin", origin: ORIGIN }, options.token);
    const { url } = expect(started, 200);
    assert.ok(url.startsWith(`${ENDPOINTS.authorize}?`));
    assert.equal(new URL(url).searchParams.get("redirect_uri"), `${ORIGIN}/auth/google`);
    const { state, code } = google.consent(url, claims, options.signer);
    const finished = await server.call("/auth/google/finish", { state, code }, options.token, { "User-Agent": CHROME_ANDROID });
    return { ...finished, state, code, url };
  }

  // A request whose body arrives only once `release` resolves (a slow
  // upload): it's signed in when it starts, and acts when the body is in.
  const slowPost = (server: Server, path: string, body: unknown, token: string, release: Promise<void>) => {
    const stream = new ReadableStream({
      async start(controller) {
        await release;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        controller.close();
      },
    });
    return server.app
      .request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: stream,
        duplex: "half",
      } as RequestInit)
      .then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }));
  };

  const dir = mkdtempSync(join(tmpdir(), "anthill-accounts-"));
  let server = await boot(dir);

  // The Google emails' side file (see store.ts), as on disk, and the log.
  const emailsPath = join(dir, "google-emails.json");
  const emailsOnFile = (): Record<string, { sub: string; email: string }> =>
    existsSync(emailsPath) ? JSON.parse(readFileSync(emailsPath, "utf8")) : {};
  const logText = () => readFileSync(join(dir, "log.jsonl"), "utf8");
  const notInLog = (...emails: string[]) => {
    const log = logText();
    for (const email of emails) assert.ok(!log.includes(email), `the log has ${email}`);
  };

  ////////////////////////////////////////////
  //// Google sign-in

  expect(await server.call("/auth/methods"), 200);
  assert.deepEqual((await server.call("/auth/methods")).data, { passkey: true, google: true });
  {
    const off = await boot(mkdtempSync(join(tmpdir(), "anthill-accounts-off-")), {});
    assert.deepEqual((await off.call("/auth/methods")).data, { passkey: true, google: false });
    expect(await off.call("/auth/google/start", { intent: "signin", origin: ORIGIN }), 400);
    process.env.DATA_DIR = dir;
  }
  expect(await server.call("/auth/google/start", { intent: "signin", origin: "https://evil.example" }), 400);
  expect(await server.call("/auth/google/start", { intent: "both", origin: ORIGIN }), 400);
  expect(await server.call("/auth/google/start", { intent: "link", origin: ORIGIN }), 401);

  const gina = { sub: "g-1001", email: "gina@example.com", given_name: "Gina", name: "Gina Gaul" };
  const first = await viaGoogle(server, gina);
  const ginaSession = expect(first, 200);
  assert.equal(ginaSession.created, true);
  assert.equal(ginaSession.user.name, "Gina");
  assert.equal(ginaSession.recoveryCode, undefined);
  assert.equal(google.jwksFetches, 1);
  {
    const me = expect(await server.call("/auth/me", undefined, ginaSession.token), 200);
    assert.deepEqual(me.methods, { passkeys: 0, google: { email: "gina@example.com" }, recoveryCode: false });
  }
  // the email is in the side file, only the owner can read it, and the log
  // has the sub only
  notInLog("gina@example.com");
  assert.ok(logText().includes('"google":{"sub":"g-1001"}'));
  assert.deepEqual(emailsOnFile()[ginaSession.user.id], { sub: "g-1001", email: "gina@example.com" });
  assert.equal(statSync(emailsPath).mode & 0o777, 0o600);
  assert.equal(existsSync(`${emailsPath}.tmp`), false);
  // the same Google account signs in to the same Anthill account
  const again = expect(await viaGoogle(server, gina), 200);
  assert.equal(again.created, false);
  assert.equal(again.user.id, ginaSession.user.id);
  assert.equal(google.jwksFetches, 1, "Google's keys are cached for their max-age");
  // a new email at Google: the side file follows it, the log gets nothing
  {
    const logBefore = logText();
    const changed = expect(await viaGoogle(server, { ...gina, email: "gina.new@example.com" }), 200);
    assert.equal(changed.user.id, ginaSession.user.id);
    assert.equal(expect(await server.call("/auth/me", undefined, changed.token), 200).methods.google.email, "gina.new@example.com");
    assert.equal(emailsOnFile()[ginaSession.user.id].email, "gina.new@example.com");
    notInLog("gina.new@example.com");
    assert.ok(!logText().slice(logBefore.length).includes('"type":"googleLinked"'));
    expect(await viaGoogle(server, gina), 200);
    assert.equal(emailsOnFile()[ginaSession.user.id].email, "gina@example.com");
  }
  // a state is used once
  expect(await server.call("/auth/google/finish", { state: first.state, code: first.code }), 401, "Google sign-in expired, try again.");
  // a name Google gives that cleans to nothing falls back
  const nameless = expect(await viaGoogle(server, { sub: "g-1002", email: "x@example.com", given_name: "​", name: undefined }), 200);
  assert.equal(nameless.user.name, "New member");
  // within the clock skew is still fine
  expect(await viaGoogle(server, { sub: "g-1003", exp: Math.floor(Date.now() / 1000) - 30 }), 200);
  ok("Google sign-in, an account per Google account, keys cached, states used once");

  const NOT_VERIFIED = "Google's answer couldn't be verified. Try again.";
  for (const [why, claims, signer] of [
    ["a bad signature", { sub: "g-bad-1" }, { key: google.stranger }],
    ["a key Google never published", { sub: "g-bad-2" }, { key: google.stranger, kid: "nobody" }],
    ["another audience", { sub: "g-bad-3", aud: "someone-else.apps.googleusercontent.com" }, {}],
    ["another issuer", { sub: "g-bad-4", iss: "https://evil.example" }, {}],
    ["an expired token", { sub: "g-bad-5", exp: Math.floor(Date.now() / 1000) - 120 }, {}],
    ["the wrong nonce", { sub: "g-bad-6", nonce: "not-the-nonce" }, {}],
    ["no nonce", { sub: "g-bad-7", nonce: undefined }, {}],
    ["no sub", { sub: undefined }, {}],
  ] as const) {
    const res = await viaGoogle(server, claims, { signer });
    assert.equal(res.status, 401, `${why}: ${JSON.stringify(res.data)}`);
    assert.equal(res.data.error, NOT_VERIFIED, why);
  }
  // nothing was made for them: a good token for the same sub is a new account
  assert.equal(expect(await viaGoogle(server, { sub: "g-bad-1" }), 200).created, true);
  // a code the token endpoint refuses (a wrong code, here) signs nobody in
  {
    const started = expect(await server.call("/auth/google/start", { intent: "signin", origin: ORIGIN }), 200);
    const { state } = google.consent(started.url, { sub: "g-1004" });
    expect(await server.call("/auth/google/finish", { state, code: "made-up" }), 401, "Google didn't confirm the sign-in. Try again.");
  }
  // Google starts signing with a new key: fetched once for the unknown id
  const fetchesBefore = google.jwksFetches;
  google.rotate();
  expect(await viaGoogle(server, gina), 200);
  assert.equal(google.jwksFetches, fetchesBefore + 1);
  expect(await viaGoogle(server, gina), 200);
  assert.equal(google.jwksFetches, fetchesBefore + 1);
  ok("id_tokens with a bad signature, audience, issuer, expiry, nonce or sub are refused");

  // A state is the flow, sealed: changed, expired or from another server's
  // secret, it's refused; and no number of starts (they need no sign-in)
  // crowds out a flow someone is in the middle of.
  {
    const expired = "Google sign-in expired, try again.";
    const started = expect(await server.call("/auth/google/start", { intent: "signin", origin: ORIGIN }), 200);
    const { state, code } = google.consent(started.url, { sub: "g-1005" });
    const flipped = `${state.slice(0, 20)}${state[20] === "A" ? "B" : "A"}${state.slice(21)}`;
    expect(await server.call("/auth/google/finish", { state: flipped, code }), 401, expired);
    expect(await server.call("/auth/google/finish", { state: "x".repeat(5000), code }), 401, expired);
    // the same state spelt another way (the decoder would skip the extra)
    expect(await server.call("/auth/google/finish", { state: `${state}!`, code }), 401, expired);
    const elsewhere = new GoogleSignIn("another server's secret", googleOptions);
    const foreign = google.consent(elsewhere.start("signin", ORIGIN).url, { sub: "g-1005" });
    expect(await server.call("/auth/google/finish", foreign), 401, expired);
    // the verifier and nonce aren't readable in the state
    assert.ok(!Buffer.from(state, "base64url").toString("latin1").includes("verifier"));
    later(11 * 60_000);
    expect(await server.call("/auth/google/finish", { state, code }), 401, expired);
    Date.now = realNow;

    const direct = new GoogleSignIn("a secret", googleOptions);
    const victim = google.consent(direct.start("signin", ORIGIN).url, { sub: "g-1006", email: "v@example.com" });
    for (let i = 0; i < 12_000; i++) direct.start("signin", ORIGIN);
    const done = await direct.finish(victim.state, victim.code);
    assert.equal(done.identity.sub, "g-1006");
    // and once only
    await assert.rejects(direct.finish(victim.state, victim.code), (e: Error) => e.message === expired);
  }
  ok("Google states: sealed, expiring, used once, and not crowded out by a flood of starts");

  // Linking: a passkey account adds Google, needs a fresh sign-in, the flow
  // is bound to the account, and a Google account is linked to one account.
  const ann = await register(server, "Ann");
  const annGoogle = { sub: "g-2001", email: "ann@example.com", given_name: "Annie" };
  {
    const bob = await register(server, "Bob");
    // finished by someone else: refused
    const started = expect(await server.call("/auth/google/start", { intent: "link", origin: ORIGIN }, ann.token), 200);
    const { state, code } = google.consent(started.url, annGoogle);
    expect(await server.call("/auth/google/finish", { state, code }, bob.token), 401, "This Google link was started for another account.");
  }
  const linked = expect(await viaGoogle(server, annGoogle, { intent: "link", token: ann.token }), 200);
  assert.deepEqual(linked, { google: { email: "ann@example.com" } });
  notInLog("ann@example.com");
  assert.deepEqual(emailsOnFile()[ann.user.id], { sub: "g-2001", email: "ann@example.com" });
  assert.deepEqual(
    expect(await server.call("/auth/me", undefined, ann.token), 200).methods,
    { passkeys: 1, google: { email: "ann@example.com" }, recoveryCode: true },
  );
  // now Google signs in to Ann's account
  const annViaGoogle = expect(await viaGoogle(server, annGoogle), 200);
  assert.equal(annViaGoogle.user.id, ann.user.id);
  expect(
    await viaGoogle(server, gina, { intent: "link", token: ann.token }),
    400,
    "That Google account is already linked to another Anthill account.",
  );
  {
    const cat = await register(server, "Cat");
    expect(
      await viaGoogle(server, annGoogle, { intent: "link", token: cat.token }),
      400,
      "That Google account is already linked to another Anthill account.",
    );
    // a second Google account for Ann: unlink the first
    expect(
      await viaGoogle(server, { sub: "g-2002" }, { intent: "link", token: ann.token }),
      400,
      "Your account is already linked to another Google account. Unlink it first.",
    );
  }
  // linking needs a fresh sign-in
  later(11 * 60_000);
  expect(await server.call("/auth/google/start", { intent: "link", origin: ORIGIN }, ann.token), 401);
  Date.now = realNow;
  // Unlinking: refused without a passkey; Ann has one
  expect(
    await server.call("/auth/google/unlink", {}, ginaSession.token),
    400,
    "Add a passkey first, or you'd have no way to sign in.",
  );
  // unlinking ends the sessions Google made (a Google account given up as
  // compromised signs nobody in any more), not the caller's
  assert.equal(expect(await server.call("/auth/google/unlink", {}, ann.token), 200).endedSessions, 1);
  assert.equal(expect(await server.call("/auth/me", undefined, ann.token), 200).methods.google, null);
  // its email is erased: not in the side file, nor in the log ever
  assert.equal(emailsOnFile()[ann.user.id], undefined);
  assert.ok(!readFileSync(emailsPath, "utf8").includes("ann@example.com"));
  notInLog("ann@example.com");
  expect(await server.call("/auth/me", undefined, annViaGoogle.token), 401, "session expired");
  // and the Google account signs in to a new account now
  assert.notEqual(expect(await viaGoogle(server, annGoogle), 200).user.id, ann.user.id);
  ok("linking and unlinking Google, one each way, never the last way in, its sessions ending");

  // Confirming it's you with Google (an account without passkeys, whose
  // sign-in isn't recent): only with the Google account linked to it.
  {
    const logSize = () => readFileSync(join(dir, "log.jsonl")).length;
    expect(await server.call("/auth/google/start", { intent: "confirm", origin: ORIGIN }), 401);
    // a passkey account without Google has nothing to confirm with
    const pat = await register(server, "Pat");
    expect(await server.call("/auth/google/start", { intent: "confirm", origin: ORIGIN }, pat.token), 400, "No Google account is linked to yours.");
    const stale = expect(await viaGoogle(server, gina), 200);
    later(11 * 60_000);
    expect(await server.call("/auth/recovery-code", {}, stale.token), 401);
    const wrong = "That's a different Google account from the one linked to your Anthill account.";
    // another account's Google account: refused, nothing written
    {
      const started = expect(await server.call("/auth/google/start", { intent: "confirm", origin: ORIGIN }, stale.token), 200);
      const { state, code } = google.consent(started.url, { sub: "g-1002", email: "x@example.com" });
      const before = logSize();
      expect(await server.call("/auth/google/finish", { state, code }, stale.token), 400, wrong);
      assert.equal(logSize(), before);
    }
    // a Google account new to Anthill: refused, and no account is made
    {
      const started = expect(await server.call("/auth/google/start", { intent: "confirm", origin: ORIGIN }, stale.token), 200);
      const { state, code } = google.consent(started.url, { sub: "g-never-seen", email: "new@example.com" });
      const before = logSize();
      expect(await server.call("/auth/google/finish", { state, code }, stale.token), 400, wrong);
      assert.equal(logSize(), before);
      assert.equal(new Store(dir).userByGoogleSub("g-never-seen"), undefined);
    }
    // finished by another account: refused
    {
      const started = expect(await server.call("/auth/google/start", { intent: "confirm", origin: ORIGIN }, stale.token), 200);
      const { state, code } = google.consent(started.url, gina);
      expect(await server.call("/auth/google/finish", { state, code }, pat.token), 401, "This confirmation was started for another account.");
    }
    // the right one: a fresh session for the same account, and the one that
    // started it ends; Google is told whose account to offer
    const confirmed = await viaGoogle(server, gina, { intent: "confirm", token: stale.token });
    assert.equal(new URL(confirmed.url).searchParams.get("login_hint"), "gina@example.com");
    const fresh = expect(confirmed, 200);
    assert.deepEqual(Object.keys(fresh).sort(), ["token", "user"]);
    assert.equal(fresh.user.id, ginaSession.user.id);
    expect(await server.call("/auth/recovery-code", {}, fresh.token), 200);
    expect(await server.call("/auth/me", undefined, stale.token), 401, "session expired");
    Date.now = realNow;
  }
  ok("confirming it's you with Google: only the linked Google account, never a new account");

  // Recovery evicts whatever a lost device could have added, a Google
  // account linked from it too: the recovered account's Google sign-in no
  // longer reaches it.
  {
    const rex = await register(server, "Rex");
    const intruder = { sub: "g-6001", email: "intruder@example.com" };
    expect(await viaGoogle(server, intruder, { intent: "link", token: rex.token }), 200);
    const intruderSession = expect(await viaGoogle(server, intruder), 200);
    assert.equal(intruderSession.user.id, rex.user.id);
    const options = expect(await server.call("/auth/recover/options", { code: rex.recoveryCode }), 200);
    const fresh = new SoftPasskey();
    const recovered = expect(
      await server.call("/auth/recover/verify", { flowId: options.flowId, response: fresh.create(options.options) }),
      200,
    );
    assert.deepEqual(recovered.googleUnlinked, { email: "intruder@example.com" });
    // said once, to whoever recovered, and erased
    assert.equal(emailsOnFile()[rex.user.id], undefined);
    assert.ok(!readFileSync(emailsPath, "utf8").includes("intruder@example.com"));
    notInLog("intruder@example.com");
    expect(await server.call("/auth/me", undefined, intruderSession.token), 401);
    assert.equal(expect(await server.call("/auth/me", undefined, recovered.token), 200).methods.google, null);
    const after = expect(await viaGoogle(server, intruder), 200);
    assert.equal(after.created, true);
    assert.notEqual(after.user.id, rex.user.id);
    const replayed = new Store(dir);
    assert.equal(replayed.googleOf(rex.user.id), undefined);
    assert.equal(replayed.userByGoogleSub("g-6001")?.id, after.user.id);
  }
  ok("recovery unlinks Google");

  // The email is the account holder's only: not in a community's tree,
  // profile or summary.
  {
    const created = await server.call(
      "/communities",
      { id: "gina-place", name: "Gina's place", visibility: "public", joinPolicy: "open" },
      ginaSession.token,
    );
    expect(created, 200);
    for (const path of ["/c/gina-place/graph", "/communities", "/c/gina-place", "/c/gina-place/history"]) {
      const res = await server.call(path);
      assert.ok(!res.text.includes("gina@example.com"), path);
      assert.ok(!res.text.includes("g-1001"), path);
    }
  }
  ok("the Google email stays private");

  ////////////////////////////////////////////
  //// sessions

  {
    const dan = await register(server, "Dan", SAFARI_MAC);
    const phone = expect(await signIn(server, dan.passkey, CHROME_ANDROID), 200);
    const list = expect(await server.call("/auth/sessions", undefined, dan.token), 200).sessions;
    assert.equal(list.length, 2);
    assert.deepEqual(
      list.map((s: any) => [s.method, s.device, s.current]),
      [
        ["passkey", "Chrome on Android", false],
        ["register", "Safari on macOS", true],
      ],
    );
    // another account's session can't be ended, nor one that ended
    const eve = await register(server, "Eve");
    const eveSid = expect(await server.call("/auth/sessions", undefined, eve.token), 200).sessions[0].id;
    expect(await server.call(`/auth/sessions/${eveSid}/end`, {}, dan.token), 400, "That session has already ended.");
    expect(await server.call("/auth/me", undefined, eve.token), 200);
    // ending one needs no fresh sign-in
    later(11 * 60_000);
    expect(await server.call(`/auth/sessions/${list[0].id}/end`, {}, dan.token), 200);
    Date.now = realNow;
    expect(await server.call("/auth/me", undefined, phone.token), 401, "session expired");
    expect(await server.call(`/auth/sessions/${list[0].id}/end`, {}, dan.token), 400, "That session has already ended.");
    assert.equal(expect(await server.call("/auth/sessions", undefined, dan.token), 200).sessions.length, 1);
    // signing out ends the caller's session
    const laptop = expect(await signIn(server, dan.passkey), 200);
    expect(await server.call("/auth/sign-out", {}, laptop.token), 200);
    expect(await server.call("/auth/me", undefined, laptop.token), 401, "session expired");
    // a token from before sessions were logged still works (and has no
    // session to end), until sign out everywhere
    const secret = readFileSync(join(dir, "session-secret"), "utf8").trim();
    const payload = b64url(JSON.stringify({ uid: dan.user.id, iat: Date.now(), exp: Date.now() + 60_000, v: 0 }));
    const legacy = `${payload}.${createHmac("sha256", Buffer.from(secret)).update(payload).digest("base64url")}`;
    expect(await server.call("/auth/me", undefined, legacy), 200);
    assert.ok(expect(await server.call("/auth/sessions", undefined, legacy), 200).sessions.every((s: any) => !s.current));
    // a sid made up (or from another account) is refused
    const forged = b64url(JSON.stringify({ uid: dan.user.id, iat: Date.now(), exp: Date.now() + 60_000, v: 0, sid: eveSid }));
    const forgedToken = `${forged}.${createHmac("sha256", Buffer.from(secret)).update(forged).digest("base64url")}`;
    expect(await server.call("/auth/me", undefined, forgedToken), 401, "session expired");

    // after a restart: ended sessions stay ended, open ones stay open
    server = await boot(dir);
    expect(await server.call("/auth/me", undefined, phone.token), 401, "session expired");
    expect(await server.call("/auth/me", undefined, laptop.token), 401, "session expired");
    expect(await server.call("/auth/me", undefined, dan.token), 200);
    expect(await server.call("/auth/me", undefined, legacy), 200);
    assert.equal(expect(await server.call("/auth/sessions", undefined, dan.token), 200).sessions.length, 1);
    // sign out everywhere ends them all, the old token too, and the list empties
    expect(await server.call("/auth/sign-out-everywhere", {}, dan.token), 200);
    for (const t of [dan.token, legacy]) expect(await server.call("/auth/me", undefined, t), 401);
    const back = expect(await signIn(server, dan.passkey), 200);
    assert.equal(expect(await server.call("/auth/sessions", undefined, back.token), 200).sessions.length, 1);
  }
  ok("sessions listed, ended and signed out, also after a restart");

  ////////////////////////////////////////////
  //// passkeys

  {
    const fay = await register(server, "Fay");
    const [only] = expect(await server.call("/auth/passkeys", undefined, fay.token), 200).passkeys;
    assert.ok(only.createdAt && only.lastUsedAt, JSON.stringify(only));
    assert.deepEqual(only.transports, ["internal"]);
    assert.equal(only.publicKey, undefined);
    expect(
      await server.call(`/auth/passkeys/${encodeURIComponent(only.id)}/remove`, {}, fay.token),
      400,
      "That's your only way to sign in. Add another passkey or link a Google account first.",
    );
    // a second one, then the first can go
    const options = expect(await server.call("/auth/passkeys/options", {}, fay.token), 200);
    const laptop = new SoftPasskey();
    expect(
      await server.call(
        "/auth/passkeys/verify",
        { flowId: options.flowId, response: laptop.create(options.options) },
        fay.token,
      ),
      200,
    );
    // someone else's passkey isn't yours to remove
    expect(await server.call(`/auth/passkeys/${encodeURIComponent(only.id)}/remove`, {}, ann.token), 400, "That passkey isn't on your account.");
    // removing needs a fresh sign-in
    later(11 * 60_000);
    expect(await server.call(`/auth/passkeys/${encodeURIComponent(only.id)}/remove`, {}, fay.token), 401);
    Date.now = realNow;
    // the sessions it made end with it (the lost phone is signed out), all
    // but the caller's; another passkey's sessions stay
    const phone = expect(await signIn(server, fay.passkey, CHROME_ANDROID), 200);
    const onLaptop = expect(await signIn(server, laptop), 200);
    const removed = expect(await server.call(`/auth/passkeys/${encodeURIComponent(only.id)}/remove`, {}, fay.token), 200);
    assert.equal(removed.endedSessions, 1);
    expect(await server.call("/auth/me", undefined, phone.token), 401, "session expired");
    expect(await server.call("/auth/me", undefined, fay.token), 200);
    expect(await server.call("/auth/me", undefined, onLaptop.token), 200);
    expect(await signIn(server, fay.passkey), 401, "unknown passkey");
    const [left] = expect(await server.call("/auth/passkeys", undefined, onLaptop.token), 200).passkeys;
    assert.equal(left.id, laptop.credentialId.toString("base64url"));
    // a sign-in under way while its passkey is removed signs nobody in
    {
      const spare = new SoftPasskey();
      const addOptions = expect(await server.call("/auth/passkeys/options", {}, onLaptop.token), 200);
      expect(await server.call("/auth/passkeys/verify", { flowId: addOptions.flowId, response: spare.create(addOptions.options) }, onLaptop.token), 200);
      const spareId = spare.credentialId.toString("base64url");
      const loginOptions = expect(await server.call("/auth/login/options", {}), 200);
      const held = holdNext("verify");
      const signingIn = server.call("/auth/login/verify", { flowId: loginOptions.flowId, response: spare.get(loginOptions.options) });
      await held.atIt;
      expect(await server.call(`/auth/passkeys/${encodeURIComponent(spareId)}/remove`, {}, onLaptop.token), 200);
      held.release();
      expect(await signingIn, 401, "unknown passkey");
      assert.ok(!readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").some((l) => l.includes('"type":"session"') && l.includes(`"passkey":"${spareId}"`)));
      // nor is a passkey added by a session signed out everywhere meanwhile
      const other = expect(await signIn(server, laptop), 200);
      const late = new SoftPasskey();
      const lateOptions = expect(await server.call("/auth/passkeys/options", {}, other.token), 200);
      const heldAdd = holdNext("digest");
      const adding = server.call("/auth/passkeys/verify", { flowId: lateOptions.flowId, response: late.create(lateOptions.options) }, other.token);
      await heldAdd.atIt;
      expect(await server.call("/auth/sign-out-everywhere", {}, other.token), 200);
      heldAdd.release();
      expect(await adding, 401, "session expired");
      assert.equal(new Store(dir).passkey(late.credentialId.toString("base64url")), undefined);
    }
    const viaLaptop = expect(await signIn(server, laptop), 200);
    // with Google linked, the last passkey can go (Google still signs in),
    // and then Google can't be unlinked
    expect(await viaGoogle(server, { sub: "g-3001", email: "fay@example.com" }, { intent: "link", token: viaLaptop.token }), 200);
    expect(await server.call(`/auth/passkeys/${encodeURIComponent(left.id)}/remove`, {}, viaLaptop.token), 200);
    assert.equal(expect(await server.call("/auth/me", undefined, viaLaptop.token), 200).methods.passkeys, 0);
    expect(await server.call("/auth/google/unlink", {}, viaLaptop.token), 400, "Add a passkey first, or you'd have no way to sign in.");
    assert.equal(expect(await viaGoogle(server, { sub: "g-3001", email: "fay@example.com" }), 200).user.id, fay.user.id);
    // also after a restart, which keeps the email of a linked account
    server = await boot(dir);
    expect(await signIn(server, laptop), 401, "unknown passkey");
    assert.equal(expect(await server.call("/auth/me", undefined, viaLaptop.token), 200).methods.google.email, "fay@example.com");
    assert.equal(new Store(dir).googleOf(fay.user.id)?.email, "fay@example.com");
    assert.equal(expect(await viaGoogle(server, { sub: "g-3001", email: "fay@example.com" }), 200).user.id, fay.user.id);
    notInLog("fay@example.com");
  }
  ok("passkeys listed and removed, never the last way in, their sessions ending, no sign-in while removed");

  ////////////////////////////////////////////
  //// export

  {
    const gus = await register(server, "Gus");
    const hal = await register(server, "Hal");
    expect(await viaGoogle(server, { sub: "g-4001", email: "hal-private@example.com" }, { intent: "link", token: hal.token }), 200);
    expect(await server.call("/profile", { bio: "Gus here", link: "https://gus.example" }, gus.token), 200);
    expect(await server.call("/profile", { bio: "Hal's secret-ish bio", link: "" }, hal.token), 200);
    const community = { id: "export-town", name: "Export town", visibility: "public", joinPolicy: "open" };
    expect(await server.call("/communities", community, gus.token), 200);
    expect(await server.call("/c/export-town/action", { fn: "joinTree", args: { name: "Hal", recipient: gus.user.id } }, hal.token), 200);
    const poll = expect(await server.call("/c/export-town/polls", { question: "Lunch?", options: ["Yes", "No"] }, gus.token), 200).poll;
    expect(await server.call(`/c/export-town/polls/${poll.id}/vote`, { option: 0 }, gus.token), 200);
    expect(await server.call(`/c/export-town/polls/${poll.id}/vote`, { option: 1 }, hal.token), 200);
    const invite = expect(await server.call("/c/export-town/invites", {}, gus.token), 200);

    const res = await server.call("/auth/export", undefined, gus.token);
    assert.equal(res.status, 200, res.text);
    assert.match(res.headers.get("Content-Disposition") ?? "", /^attachment; filename="anthill-account-0x[0-9a-f]{40}\.json"$/);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const data = res.data;
    assert.equal(data.account.id, gus.user.id);
    assert.equal(data.account.name, "Gus");
    assert.deepEqual(data.account.signInMethods, { passkeys: 1, google: null, recoveryCode: true });
    assert.deepEqual(data.profile, { bio: "Gus here", link: "https://gus.example" });
    assert.equal(data.sessions.length, 1);
    assert.equal(data.passkeys[0].id, gus.passkey.credentialId.toString("base64url"));
    assert.deepEqual(data.communities, [
      { id: "export-town", name: "Export town", parent: null, reputation: data.communities[0].reputation, founder: true },
    ]);
    assert.ok(BigInt(data.communities[0].reputation) > 0n);
    const types = data.log.map((e: any) => e.type);
    for (const t of ["passkey", "recovery", "session", "profile", "community", "action", "poll", "pollVote", "invite"]) {
      assert.ok(types.includes(t), `the export has a ${t} entry`);
    }
    // Hal's join names Gus as recipient: about him, so in it
    assert.ok(data.log.some((e: any) => e.type === "action" && e.by === hal.user.id && e.action.fn === "joinTree"));
    assert.ok(data.log.some((e: any) => e.type === "invite" && e.invite.code === invite.code));
    // no keys or hashes, nothing private of Hal's
    assert.ok(!/"publicKey"|"hash"/.test(res.text), "no public keys or recovery hashes");
    for (const secret of [
      "hal-private@example.com",
      "g-4001",
      "Hal's secret-ish bio",
      hal.passkey.credentialId.toString("base64url"),
      hal.token.split(".")[0],
    ]) {
      assert.ok(!res.text.includes(secret), `the export leaks ${secret}`);
    }
    for (const s of expect(await server.call("/auth/sessions", undefined, hal.token), 200).sessions) {
      assert.ok(!res.text.includes(s.id), "the export leaks Hal's session");
    }
    assert.ok(!data.log.some((e: any) => e.type === "pollVote" && e.by === hal.user.id));
    // Hal's own export has his Google account, and his vote in Gus's poll
    // says what it was about (not who asked), with the result once closed
    expect(await server.call(`/c/export-town/polls/${poll.id}/close`, {}, gus.token), 200);
    const hals = expect(await server.call("/auth/export", undefined, hal.token), 200);
    assert.deepEqual(hals.account.signInMethods.google, { sub: "g-4001", email: "hal-private@example.com" });
    // from the side file: the log entries in it have only the sub
    assert.deepEqual(hals.log.find((e: any) => e.type === "googleLinked").google, { sub: "g-4001" });
    notInLog("hal-private@example.com");
    assert.equal(hals.communities[0].parent, gus.user.id);
    const halsVote = hals.log.find((e: any) => e.type === "pollVote");
    assert.deepEqual(halsVote.poll, { community: "export-town", question: "Lunch?", options: ["Yes", "No"] });
    assert.ok(hals.log.some((e: any) => e.type === "pollClose" && e.pollId === poll.id));
    assert.ok(!hals.log.some((e: any) => e.type === "poll"));
    // five an hour
    for (let i = 0; i < 4; i++) expect(await server.call("/auth/export", undefined, gus.token), 200);
    expect(await server.call("/auth/export", undefined, gus.token), 429);
    // ten an hour from one IP, however many accounts ask
    const from = (ip: string) => ({ "X-Forwarded-For": ip });
    const many = [await register(server, "Ike"), await register(server, "Ida"), await register(server, "Ivo")];
    for (let i = 0; i < 10; i++) {
      expect(await server.call("/auth/export", undefined, many[Math.floor(i / 4)].token, from("198.51.100.7")), 200);
    }
    expect(await server.call("/auth/export", undefined, many[2].token, from("198.51.100.7")), 429);
    // one at a time, and only a few waiting: more at once are refused
    const at = await Promise.all(
      many.concat([await register(server, "Ira")]).map((who, i) =>
        server.call("/auth/export", undefined, who.token, from(`198.51.100.${20 + i}`)),
      ),
    );
    assert.deepEqual(at.map((r) => r.status), [200, 200, 200, 429]);
  }
  ok("the export has everything about you, no keys, nothing private of others, limited per IP and one at a time");

  ////////////////////////////////////////////
  //// deleting an account

  {
    // Dee founded "leaving" and is its root, with two children, the first
    // with one of its own: Dee <- Ivy <- Kit, Dee <- Jo. In "middle", Ivy
    // is under its root Lou and has two children: Lou <- Ivy <- {Max, Ned}.
    const dee = await register(server, "Dee");
    const ivy = await register(server, "Ivy");
    const jo = await register(server, "Jo");
    const kit = await register(server, "Kit");
    const lou = await register(server, "Lou");
    const max = await register(server, "Max");
    const ned = await register(server, "Ned");
    const join = (cid: string, who: { token: string }, name: string, under: string) =>
      server.call(`/c/${cid}/action`, { fn: "joinTree", args: { name, recipient: under } }, who.token);
    expect(await server.call("/communities", { id: "leaving", name: "Leaving", visibility: "private", joinPolicy: "invite" }, dee.token), 200);
    const inviteTo = async (cid: string, by: { token: string }) =>
      expect(await server.call(`/c/${cid}/invites`, {}, by.token), 200).code;
    const joinWith = async (cid: string, who: { token: string }, name: string, by: { token: string }) =>
      expect(
        await server.call(`/c/${cid}/action`, { fn: "joinTree", args: { name, invite: await inviteTo(cid, by) } }, who.token),
        200,
      );
    await joinWith("leaving", ivy, "Ivy", dee);
    await joinWith("leaving", jo, "Jo", dee);
    await joinWith("leaving", kit, "Kit", ivy);
    expect(await server.call("/communities", { id: "middle", name: "Middle", visibility: "public", joinPolicy: "open" }, lou.token), 200);
    expect(await join("middle", ivy, "Ivy", lou.user.id), 200);
    expect(await join("middle", max, "Max", ivy.user.id), 200);
    expect(await join("middle", ned, "Ned", ivy.user.id), 200);
    // Dee alone in "solo", which she founded
    expect(await server.call("/communities", { id: "solo", name: "Solo", visibility: "public", joinPolicy: "open" }, dee.token), 200);
    // Dee is also in "middle", under Ned
    expect(await join("middle", dee, "Dee", ned.user.id), 200);
    expect(await server.call("/profile", { bio: "Dee's bio", link: "" }, dee.token), 200);
    expect(await viaGoogle(server, { sub: "g-5001", email: "dee@example.com" }, { intent: "link", token: dee.token }), 200);
    const deeElsewhere = expect(await signIn(server, dee.passkey), 200);

    const parentsIn = async (cid: string, token?: string) => {
      const graph = expect(await server.call(`/c/${cid}/graph`, undefined, token), 200);
      return { rootId: graph.rootId as string, nodes: graph.nodes as Record<string, { sentTreeVote: string }>, graph };
    };

    // the name, typed exactly; a recent sign-in
    expect(await server.call("/auth/delete", { confirm: "dee" }, dee.token), 400, "To confirm, type your account name exactly as it's shown.");
    expect(await server.call("/auth/delete", {}, dee.token), 400);
    later(11 * 60_000);
    expect(await server.call("/auth/delete", { confirm: "Dee" }, dee.token), 401);
    Date.now = realNow;
    const historyBefore = expect(await server.call("/c/middle/history"), 200).steps.length;
    expect(await server.call("/auth/delete", { confirm: " Dee " }, dee.token), 200);

    // "leaving": Ivy (the first child) took Dee's place as root, her branch
    // (Kit) rose with her, and Jo (the second child) went under her;
    // everyone is still reached from the root
    const leaving = await parentsIn("leaving", ivy.token);
    assert.equal(leaving.rootId, ivy.user.id);
    assert.equal(leaving.nodes[dee.user.id], undefined);
    assert.equal(leaving.graph.community.members, 3);
    assert.equal(leaving.nodes[kit.user.id].sentTreeVote, ivy.user.id);
    assert.equal(leaving.nodes[jo.user.id].sentTreeVote, ivy.user.id);
    // "middle": Dee (a leaf) is gone; the rest is unchanged
    const middle = await parentsIn("middle");
    assert.equal(middle.rootId, lou.user.id);
    assert.equal(middle.nodes[dee.user.id], undefined);
    assert.equal(middle.graph.community.members, 4);
    const steps = expect(await server.call("/c/middle/history"), 200).steps;
    assert.equal(steps.length, historyBefore + 1);
    assert.equal(steps.at(-1).voter, dee.user.id);
    // "solo" is empty and has no founder
    const solo = await parentsIn("solo");
    assert.equal(solo.graph.community.members, 0);
    assert.equal(solo.graph.community.founder, null);
    // a founderless community's settings are its root's to change
    assert.equal(leaving.graph.community.founder, null);
    assert.equal(leaving.graph.community.canChangeSettings, true);
    const settings = { name: "Leaving, now Ivy's", visibility: "private", joinPolicy: "invite" };
    expect(
      await server.call("/c/leaving/settings", settings, kit.token),
      400,
      "Only the root of the tree can change the settings of a community without a founder.",
    );
    expect(await server.call("/c/leaving/settings", settings, ivy.token), 200);
    // an empty founderless one is anyone's to start
    expect(await server.call("/c/solo/action", { fn: "joinTreeAsRoot", args: { name: "Lou" } }, lou.token), 200);
    // Dee can't sign in in any way, and her sessions are over
    for (const t of [dee.token, deeElsewhere.token]) expect(await server.call("/auth/me", undefined, t), 401);
    expect(await signIn(server, dee.passkey), 401, "unknown passkey");
    expect(await server.call("/auth/recover/options", { code: dee.recoveryCode }), 401);
    // the email is erased with the account
    assert.equal(emailsOnFile()[dee.user.id], undefined);
    assert.ok(!readFileSync(emailsPath, "utf8").includes("dee@example.com"));
    notInLog("dee@example.com");
    const newGoogle = expect(await viaGoogle(server, { sub: "g-5001", email: "dee@example.com" }), 200);
    assert.equal(newGoogle.created, true);
    assert.notEqual(newGoogle.user.id, dee.user.id);
    // the account stays, renamed (what its old polls show as their creator)
    assert.equal(new Store(dir).user(dee.user.id)?.name, "Deleted account");

    // all of it after a restart
    server = await boot(dir);
    const store = new Store(dir);
    assert.ok(store.isDeleted(dee.user.id));
    assert.equal(store.profile(dee.user.id), undefined);
    assert.equal(store.passkeysOf(dee.user.id).length, 0);
    assert.equal(store.googleOf(dee.user.id), undefined);
    assert.equal(store.recoveryHashOf(dee.user.id), undefined);
    for (const t of [dee.token, deeElsewhere.token]) expect(await server.call("/auth/me", undefined, t), 401);
    expect(await signIn(server, dee.passkey), 401, "unknown passkey");
    const afterRestart = await parentsIn("leaving", ivy.token);
    assert.equal(afterRestart.rootId, ivy.user.id);
    assert.equal(afterRestart.graph.community.founder, null);
    assert.equal(afterRestart.graph.community.name, "Leaving, now Ivy's");
    expect(await server.call("/c/leaving/settings", { ...settings, name: "Leaving" }, ivy.token), 200);
    assert.equal((await parentsIn("solo")).rootId, lou.user.id);

    // A member with children (Ivy in "middle"): Max takes her place, Ned
    // goes under Max.
    expect(await server.call("/auth/delete", { confirm: "Ivy" }, expect(await signIn(server, ivy.passkey), 200).token), 200);
    const middle2 = await parentsIn("middle");
    assert.equal(middle2.nodes[max.user.id].sentTreeVote, lou.user.id);
    assert.equal(middle2.nodes[ned.user.id].sentTreeVote, max.user.id);
    assert.equal(middle2.graph.community.members, 3);
    // and "leaving" (private, founderless) now has Kit as its root
    const leaving2 = await parentsIn("leaving", kit.token);
    assert.equal(leaving2.rootId, kit.user.id);
    assert.equal(leaving2.nodes[jo.user.id].sentTreeVote, kit.user.id);
    expect(await server.call("/c/leaving/settings", settings, kit.token), 200);

    // Requests signed in just before the deletion, still under way (their
    // bodies arriving late): nothing they'd write gets in, nor a second
    // delete waiting behind the first.
    {
      const vic = await register(server, "Vic");
      expect(await server.call("/communities", { id: "race-open", name: "Race", visibility: "public", joinPolicy: "open" }, lou.token), 200);
      let release!: () => void;
      const arrived = new Promise<void>((resolve) => (release = resolve));
      const pending = [
        slowPost(server, "/communities", { id: "ghost", name: "Ghost", visibility: "public", joinPolicy: "open" }, vic.token, arrived),
        slowPost(server, "/profile", { bio: "back from the dead", link: "" }, vic.token, arrived),
        slowPost(server, "/name", { name: "Zombie" }, vic.token, arrived),
        slowPost(server, "/c/race-open/action", { fn: "joinTree", args: { name: "Vic", recipient: lou.user.id } }, vic.token, arrived),
        slowPost(server, "/auth/delete", { confirm: "Vic" }, vic.token, arrived),
      ];
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await server.call("/auth/delete", { confirm: "Vic" }, vic.token), 200);
      release();
      for (const res of await Promise.all(pending)) assert.equal(res.status, 401, JSON.stringify(res.data));
      const lines = readFileSync(`${dir}/log.jsonl`, "utf8").trim().split("\n");
      const deletedAt = lines.findIndex((l) => l.includes('"type":"accountDeleted"') && l.includes(vic.user.id));
      assert.ok(deletedAt >= 0);
      assert.deepEqual(lines.slice(deletedAt + 1).filter((l) => l.includes(vic.user.id)), []);
      expect(await server.call("/c/ghost"), 404);
      const replayed = new Store(dir);
      assert.equal(replayed.user(vic.user.id)?.name, "Deleted account");
      assert.equal(replayed.profile(vic.user.id), undefined);
    }

    // A name stored before names were cleaned (two spaces, a zero-width
    // space) is confirmed as it shows.
    {
      const una = await register(server, "Una Ray");
      new Store(dir).setUserName(una.user.id, "Una  Ray\u200B");
      server = await boot(dir);
      expect(await server.call("/auth/delete", { confirm: "Una Ra" }, una.token), 400);
      expect(await server.call("/auth/delete", { confirm: "Una Ray" }, una.token), 200);
    }
  }
  ok("deleting an account: leaves every tree, can't sign in again, nothing written for it after, founderless communities run by the root");

  ////////////////////////////////////////////
  //// the Google emails' side file

  {
    const kim = await register(server, "Kim");
    expect(await viaGoogle(server, { sub: "g-7001", email: "kim@example.com" }, { intent: "link", token: kim.token }), 200);
    const kimViaGoogle = expect(await viaGoogle(server, { sub: "g-7001", email: "kim@example.com" }), 200);
    // the file gone: linked accounts show without their email, Google still
    // signs in, and the next sign-in brings the email back
    rmSync(emailsPath);
    server = await boot(dir);
    assert.deepEqual(expect(await server.call("/auth/me", undefined, kim.token), 200).methods.google, { email: null });
    const exported = expect(await server.call("/auth/export", undefined, kimViaGoogle.token), 200);
    assert.deepEqual(exported.account.signInMethods.google, { sub: "g-7001", email: null });
    const back = expect(await viaGoogle(server, { sub: "g-7001", email: "kim@example.com" }), 200);
    assert.equal(back.user.id, kim.user.id);
    assert.equal(expect(await server.call("/auth/me", undefined, kim.token), 200).methods.google.email, "kim@example.com");
    // a confirm offers no login hint while the email isn't known
    {
      rmSync(emailsPath);
      server = await boot(dir);
      const started = expect(await server.call("/auth/google/start", { intent: "confirm", origin: ORIGIN }, back.token), 200);
      assert.equal(new URL(started.url).searchParams.get("login_hint"), null);
      expect(await viaGoogle(server, { sub: "g-7001", email: "kim@example.com" }), 200);
    }
    // unlinking with no email known works too
    {
      const fresh = expect(await signIn(server, kim.passkey), 200);
      rmSync(emailsPath);
      server = await boot(dir);
      assert.equal(expect(await server.call("/auth/google/unlink", {}, fresh.token), 200).ok, true);
      assert.equal(emailsOnFile()[kim.user.id], undefined);
    }
    // unreadable: as if missing (and rewritten without the junk)
    writeFileSync(emailsPath, "{not json");
    server = await boot(dir);
    assert.deepEqual(new Store(dir).googleOf(ginaSession.user.id), { sub: "g-1001" });
    assert.deepEqual(emailsOnFile(), {});
    expect(await viaGoogle(server, gina), 200);
    assert.equal(emailsOnFile()[ginaSession.user.id].email, "gina@example.com");
    // stale lines (an unlinked account's, one for another Google account
    // than the linked one, left by a write that failed) are dropped at the
    // start
    const lee = await register(server, "Lee");
    expect(await viaGoogle(server, { sub: "g-7002", email: "lee@example.com" }, { intent: "link", token: lee.token }), 200);
    writeFileSync(
      emailsPath,
      JSON.stringify({
        ...emailsOnFile(),
        [ann.user.id]: { sub: "g-2001", email: "ann@example.com" },
        [kim.user.id]: { sub: "g-7001", email: "kim@example.com" },
        [lee.user.id]: { sub: "g-not-lees", email: "not-lee@example.com" },
      }),
    );
    const replayed = new Store(dir);
    assert.equal(replayed.googleOf(ann.user.id), undefined);
    assert.equal(replayed.googleOf(kim.user.id), undefined);
    assert.deepEqual(replayed.googleOf(lee.user.id), { sub: "g-7002" });
    assert.equal(replayed.googleOf(ginaSession.user.id)?.email, "gina@example.com");
    assert.deepEqual(Object.keys(emailsOnFile()), [ginaSession.user.id]);
    // and through it all, no email ever reached the log
    assert.ok(!/@example\.com/.test(logText()), "an email in the log");
  }
  ok("the Google email: out of the log, in its side file, erased on unlink, recovery and deletion, kept across restarts, a missing or stale file handled");

  ////////////////////////////////////////////
  //// an invite link's preview

  {
    const ola = await register(server, "Ola");
    expect(await server.call("/communities", { id: "quiet-club", name: "Quiet club", description: "Shh", visibility: "private", joinPolicy: "invite" }, ola.token), 200);
    const { code } = expect(await server.call("/c/quiet-club/invites", {}, ola.token), 200);
    // whoever holds the link: the name, description, size and the inviter
    const preview = expect(await server.call(`/invites/${code}`), 200);
    assert.equal(preview.community.name, "Quiet club");
    assert.equal(preview.community.members, 1);
    assert.equal(preview.inviter.name, "Ola");
    assert.equal(preview.community.founder, null);
    assert.equal(preview.community.rootName, "");
    // a member sees the rest
    const member = expect(await server.call(`/invites/${code}`, undefined, ola.token), 200);
    assert.equal(member.community.founder.name, "Ola");
    assert.equal(member.community.rootName, "Ola");
  }
  ok("an invite link shows a private community's name, size and inviter, not its founder or root");

  ////////////////////////////////////////////
  //// CORS, security headers, caching

  {
    const { app } = server;
    const zed = await register(server, "Zed");
    const req = (path: string, init: RequestInit = {}) => app.request(path, init);
    const securityHeadersOf = (res: Response) => ({
      nosniff: res.headers.get("X-Content-Type-Options"),
      frames: res.headers.get("X-Frame-Options"),
      referrer: res.headers.get("Referrer-Policy"),
      hsts: res.headers.get("Strict-Transport-Security"),
      coop: res.headers.get("Cross-Origin-Opener-Policy"),
      corp: res.headers.get("Cross-Origin-Resource-Policy"),
    });
    const expected = {
      nosniff: "nosniff",
      frames: "DENY",
      referrer: "no-referrer",
      hsts: "max-age=63072000; includeSubDomains",
      coop: "same-origin",
      corp: "cross-origin",
    };
    // on answers of every kind: 200, 400, 401, 404, a refused body
    for (const [path, init, status] of [
      ["/communities", {}, 200],
      ["/auth/me", {}, 401],
      ["/c/nowhere", {}, 404],
      ["/auth/google/start", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }, 400],
      ["/no-such-route", {}, 404],
    ] as const) {
      const res = await req(path, init);
      assert.equal(res.status, status, path);
      assert.deepEqual(securityHeadersOf(res), expected, path);
    }
    // nothing about accounts is cached; public reads may be
    for (const path of ["/auth/me", "/auth/methods", "/auth/sessions", "/admin/log"]) {
      assert.equal((await req(path)).headers.get("Cache-Control"), "no-store", path);
    }
    assert.equal((await req("/communities")).headers.get("Cache-Control"), null);

    // our own origin: echoed, with Authorization allowed in the preflight
    const ours = await req("/auth/me", { headers: { Origin: ORIGIN, Authorization: `Bearer ${zed.token}` } });
    assert.equal(ours.status, 200);
    assert.equal(ours.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    assert.match(ours.headers.get("Vary") ?? "", /Origin/);
    const preflight = await req("/action", {
      method: "OPTIONS",
      headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    assert.match(preflight.headers.get("Access-Control-Allow-Headers") ?? "", /Authorization/);
    assert.match(preflight.headers.get("Access-Control-Allow-Methods") ?? "", /POST/);
    const post = await req("/name", {
      method: "POST",
      headers: { Origin: ORIGIN, Authorization: `Bearer ${zed.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Zed" }),
    });
    assert.equal(post.status, 200);
    assert.equal(post.headers.get("Access-Control-Allow-Origin"), ORIGIN);

    // another site: public GETs only
    const evil = "https://evil.example";
    const publicRead = await req("/c/export-town/graph", { headers: { Origin: evil } });
    assert.equal(publicRead.status, 200);
    assert.equal(publicRead.headers.get("Access-Control-Allow-Origin"), "*");
    for (const [path, init] of [
      ["/auth/me", { headers: { Origin: evil, Authorization: `Bearer ${zed.token}` } }],
      ["/communities", { headers: { Origin: evil, Authorization: `Bearer ${zed.token}` } }],
      ["/name", { method: "POST", headers: { Origin: evil, Authorization: `Bearer ${zed.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Zed" }) }],
      ["/auth/login/options", { method: "POST", headers: { Origin: evil, "Content-Type": "application/json" }, body: "{}" }],
      ["/action", { method: "OPTIONS", headers: { Origin: evil, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization" } }],
      ["/graph", { method: "OPTIONS", headers: { Origin: evil, "Access-Control-Request-Method": "GET" } }],
    ] as const) {
      const res = await req(path, init as RequestInit);
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), null, `${init.method ?? "GET"} ${path}`);
      assert.equal(res.headers.get("Access-Control-Allow-Headers"), null, `${init.method ?? "GET"} ${path}`);
    }
    // server to server (agent-commons): no Origin, no CORS, still answered
    const direct = await req("/c/export-town/commons/tree");
    assert.equal(direct.status, 200);
    assert.equal(direct.headers.get("Access-Control-Allow-Origin"), null);
  }
  ok("CORS for our origins and public reads, security headers and no-store everywhere they belong");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
