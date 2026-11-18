// Helpers shared by the routes: rate limits, admin checks, request bodies.

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { BlockList, isIPv4, isIPv6 } from "node:net";
import { AuthError } from "./auth";
import { ActionError } from "./offchain";

type Req = { req: { header: (name: string) => string | undefined } };
// a request with the Node socket it came in on (@hono/node-server's env)
type ConnReq = Req & { env?: unknown };

// `retryAt`: when the window that refused it ends (ms since the epoch).
export class RateLimitError extends Error {
  constructor(readonly retryAt: number) {
    super("rate limited");
  }
}

// A community that doesn't exist, or that the viewer may not see.
export class NotFoundError extends Error {}

// A server Anthill relays to (a commons' coordinator) couldn't be reached or
// refused: a 502, with what to tell the person. `code` is the other server's
// error code, when it gave one.
export class RelayError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

// Fixed windows (a minute unless given) per client IP or user, to blunt
// scripted sign-ups and spam.
const rateWindows = new Map<string, { count: number; reset: number }>();
// keys kept at most (a flood of new keys can't grow the map without bound)
const MAX_RATE_KEYS = 100_000;

function sweepRateWindows() {
  const now = Date.now();
  for (const [key, w] of rateWindows) if (w.reset < now) rateWindows.delete(key);
}
setInterval(sweepRateWindows, 60_000).unref();

// The current window for `key`, a new one if it has none or it ended.
function windowOf(key: string, windowMs: number) {
  const now = Date.now();
  let w = rateWindows.get(key);
  if (w === undefined || w.reset < now) {
    if (w === undefined && rateWindows.size >= MAX_RATE_KEYS) {
      sweepRateWindows();
      // still full: forget the oldest windows (a Map keeps insertion order)
      for (const old of rateWindows.keys()) {
        if (rateWindows.size < MAX_RATE_KEYS * 0.9) break;
        rateWindows.delete(old);
      }
    }
    w = { count: 0, reset: now + windowMs };
    rateWindows.set(key, w);
  }
  return w;
}

export function rateLimit(key: string, perWindow: number, windowMs = 60_000) {
  const w = windowOf(key, windowMs);
  if (w.count >= perWindow) throw new RateLimitError(w.reset);
  w.count += 1;
}

// For what only counts once it worked (a sign-up, not a failed attempt):
// refuses when `key` already had `perWindow`...
export function rateRoom(key: string, perWindow: number) {
  const w = rateWindows.get(key);
  if (w !== undefined && w.reset >= Date.now() && w.count >= perWindow) throw new RateLimitError(w.reset);
}

// ...and counts one, never refusing (it already happened).
export function rateCount(key: string, windowMs: number) {
  windowOf(key, windowMs).count += 1;
}

// Cloudflare's published proxy ranges (cloudflare.com/ips). Render's edge is
// Cloudflare: when it adds its own hop to X-Forwarded-For, that entry is one
// of these, shared by everyone at that edge, so it's skipped like a proxy.
const CLOUDFLARE = new BlockList();
for (const range of [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
  "2a06:98c0::/29", "2c0f:f248::/32",
]) {
  const [address, prefix] = range.split("/");
  CLOUDFLARE.addSubnet(address, Number(prefix), isIPv4(address) ? "ipv4" : "ipv6");
}
const isCloudflare = (ip: string) => {
  const v4 = ip.startsWith("::ffff:") && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  if (isIPv4(v4)) return CLOUDFLARE.check(v4, "ipv4");
  return isIPv6(ip) && CLOUDFLARE.check(ip, "ipv6");
};

// Proxies in front of us that add an X-Forwarded-For entry: Render's, by
// default (Cloudflare's hops aren't counted, see above). Entries left of
// theirs come from the client and can say anything.
const PROXY_HOPS = Math.max(0, Number(process.env.TRUSTED_PROXY_HOPS ?? 1) || 0);
// Cloudflare sets (and overwrites) CF-Connecting-IP, but only when it's our
// own proxy; we aren't behind one, so by default a client could pick it.
const TRUST_CLOUDFLARE = process.env.TRUST_CLOUDFLARE === "true";
let loggedShape = false;

// The client's address, for rate limits: the entry the nearest trusted proxy
// added to X-Forwarded-For (the right-most that isn't Cloudflare's, with
// one), else the socket's.
export function clientIp(c: ConnReq) {
  if (TRUST_CLOUDFLARE) {
    const cf = c.req.header("cf-connecting-ip");
    if (cf !== undefined) return cf;
  }
  const all = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  let edge = all.length;
  while (edge > 0 && isCloudflare(all[edge - 1])) edge--;
  const forwarded = all.slice(0, edge);
  if (!loggedShape) {
    // once, to check the proxy setup in the logs (no addresses)
    loggedShape = true;
    console.log(
      `client IPs: ${all.length} X-Forwarded-For entries on the first request (${all.length - edge} Cloudflare's on the right),`,
      `CF-Connecting-IP ${c.req.header("cf-connecting-ip") === undefined ? "absent" : "present"}; using ${PROXY_HOPS} from the right`,
    );
  }
  if (PROXY_HOPS > 0 && forwarded.length >= PROXY_HOPS) return forwarded[forwarded.length - PROXY_HOPS];
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  return incoming?.socket.remoteAddress ?? "local";
}

export function requireAdmin(c: Req) {
  const token = process.env.ADMIN_TOKEN;
  const given = c.req.header("Authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
  // Digests have one length, so the comparison can't throw on a non-ASCII
  // token and doesn't reveal the token's length.
  const digest = (s: string) => createHash("sha256").update(s).digest();
  if (!token || !timingSafeEqual(digest(given), digest(token))) {
    throw new AuthError("admin only");
  }
}

// A body that may be left out (no body, or an empty one, is `{}`); one
// that's there must be a JSON object, as for jsonBody.
export async function optionalJsonBody(c: { req: { text: () => Promise<string> } }) {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ActionError("expected a JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ActionError("expected a JSON object");
  }
  return body as Record<string, unknown>;
}

// The parsed body, which must be a JSON object: routes destructure it, and
// `null` or `[]` would throw a TypeError (a 500) there.
export async function jsonBody(c: { req: { json: () => Promise<any> } }) {
  const body = await c.req.json().catch(() => {
    throw new ActionError("expected a JSON body");
  });
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ActionError("expected a JSON object");
  }
  return body;
}
