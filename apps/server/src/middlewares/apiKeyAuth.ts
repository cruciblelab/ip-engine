/**
 * Every /api/* route except /healthz requires this header to match
 * IP_INSIGHT_API_KEY exactly (see routes/index.ts for where /healthz is
 * mounted ahead of this middleware so it never reaches here). Namespaced
 * like IP_INSIGHT_CONFIG/IP_INSIGHT_SOURCES_REGISTRY rather than a bare
 * API_KEY — a generic name is exactly the kind of thing another process
 * sharing this environment (docker-compose, a PaaS dashboard) already
 * defines, and silently picking that up would be worse than not starting.
 *
 * Read once at module load, not per-request: this module is only ever
 * imported once (routes/index.ts), env vars don't change mid-process, and
 * load-env.ts already guarantees .env is loaded before anything under
 * ./routes is imported (see that file's header). Missing entirely fails
 * closed — the whole point is that a misconfigured deployment must not
 * silently serve every route unauthenticated.
 */
import type { NextFunction, Request, Response } from "express";
import crypto from "node:crypto";

const HEADER = "x-api-key";

const expectedKey = process.env["IP_INSIGHT_API_KEY"];

if (!expectedKey) {
  throw new Error(
    "IP_INSIGHT_API_KEY environment variable is required but was not provided. " +
      "apps/server has no other access control — every route would otherwise be " +
      "reachable by anyone who can reach the port. Generate one with " +
      "`openssl rand -hex 32` and set it in .env.",
  );
}

const expectedKeyBuffer = Buffer.from(expectedKey, "utf8");

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header(HEADER);

  if (typeof provided === "string" && timingSafeEqual(provided, expectedKeyBuffer)) {
    next();
    return;
  }

  res.status(401).json({ error: "unauthorized", message: `Missing or invalid ${HEADER} header` });
}

// crypto.timingSafeEqual throws on a buffer-length mismatch rather than
// returning false, and a naive `if (a.length !== b.length) return false`
// guard in front of it would itself leak the expected key's length through
// timing (short-circuits before doing any constant-time work at all). Compare
// against a same-length buffer instead so every call — right length or not —
// does the same constant-time comparison work.
function timingSafeEqual(provided: string, expected: Buffer): boolean {
  const providedBuffer = Buffer.from(provided, "utf8");
  if (providedBuffer.length !== expected.length) {
    crypto.timingSafeEqual(providedBuffer, providedBuffer);
    return false;
  }
  return crypto.timingSafeEqual(providedBuffer, expected);
}
