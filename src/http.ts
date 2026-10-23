// Helpers shared by the routes: rate limits, admin checks, request bodies.

import { timingSafeEqual } from "node:crypto";
import { AuthError } from "./auth";
import { ActionError } from "./offchain";

type Req = { req: { header: (name: string) => string | undefined } };

export class RateLimitError extends Error {}

// A community that doesn't exist, or that the viewer may not see.
export class NotFoundError extends Error {}

// Fixed one-minute windows per client IP, to blunt scripted sign-ups and spam.
const rateWindows = new Map<string, { count: number; reset: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, w] of rateWindows) if (w.reset < now) rateWindows.delete(key);
}, 60_000).unref();

export function rateLimit(key: string, perMinute: number) {
  const now = Date.now();
  const w = rateWindows.get(key);
  if (w === undefined || w.reset < now) {
    rateWindows.set(key, { count: 1, reset: now + 60_000 });
  } else if (++w.count > perMinute) {
    throw new RateLimitError();
  }
}

export function clientIp(c: Req) {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
    "local"
  );
}

export function requireAdmin(c: Req) {
  const token = process.env.ADMIN_TOKEN;
  const given = c.req.header("Authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
  if (
    !token ||
    given.length !== token.length ||
    !timingSafeEqual(Buffer.from(given), Buffer.from(token))
  ) {
    throw new AuthError("admin only");
  }
}

export async function jsonBody(c: { req: { json: () => Promise<any> } }) {
  return c.req.json().catch(() => {
    throw new ActionError("expected a JSON body");
  });
}
