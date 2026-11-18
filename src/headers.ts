// Headers on every answer: security headers, CORS and caching.
//
// CORS: the frontend's origins (ORIGINS) get their origin echoed back, with
// Authorization allowed, so they can sign in and act. Any other site gets
// `*` only on a GET without an Authorization header: public reads (a
// community's app reading its public tree, say), never anyone's session.
// Server-to-server callers (agent-commons) send no Origin and don't need any
// of it.
//
// Answers under /auth/ and /admin/ are never cached: they hold sessions,
// account details and the log.

import type { MiddlewareHandler } from "hono";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Cross-Origin-Opener-Policy": "same-origin",
  // the frontend is another site, and must still read our answers
  "Cross-Origin-Resource-Policy": "cross-origin",
};

const NO_STORE = /^\/(auth|admin)\//;

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
    if (NO_STORE.test(c.req.path)) c.header("Cache-Control", "no-store");
  };
}

export function corsPolicy(origins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(origins);
  return async (c, next) => {
    const origin = c.req.header("Origin");
    const ours = origin !== undefined && allowed.has(origin);
    if (c.req.method === "OPTIONS") {
      // A preflight: only our own pages are told they may go ahead (another
      // site's GET without Authorization needs none).
      if (!ours) {
        c.header("Vary", "Origin");
        return c.body(null, 204);
      }
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      c.header("Access-Control-Max-Age", "600");
      c.header("Vary", "Origin");
      return c.body(null, 204);
    }
    await next();
    // the answer depends on the Origin, so caches must keep them apart
    c.header("Vary", "Origin", { append: true });
    if (ours) {
      c.header("Access-Control-Allow-Origin", origin);
      // the frontend shows when to try again after a 429
      c.header("Access-Control-Expose-Headers", "Retry-After");
    } else if (origin !== undefined && c.req.method === "GET" && c.req.header("Authorization") === undefined) {
      c.header("Access-Control-Allow-Origin", "*");
    }
  };
}
