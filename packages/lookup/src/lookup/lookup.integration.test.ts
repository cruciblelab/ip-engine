/**
 * lookupIp's input-validation error path is what apps/server's /ip/:ip route
 * (see apps/server/src/routes/lookup.ts) branches on to tell a caller
 * mistake (400) apart from an infrastructure failure (500, logged). This
 * pins that `InvalidIpError` — not a plain Error — is what actually gets
 * thrown for unparseable input, so that branch can't silently regress to
 * `instanceof Error`, which would swallow the 500 case again.
 *
 * Named .integration because merely importing "./lookup" pulls in
 * @workspace/db, which requires DATABASE_URL to be set just to construct
 * its connection pool (see packages/db/src/index.ts) — even though the
 * assertions below throw before any query runs. Skipped like the rest of
 * this package's integration tests when no DATABASE_URL is configured.
 */
import { describe, expect, it } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("lookupIp input validation", () => {
  it("rejects unparseable input with InvalidIpError, not a plain Error", async () => {
    const { lookupIp, InvalidIpError } = await import("./lookup");
    await expect(lookupIp("not-an-ip")).rejects.toBeInstanceOf(InvalidIpError);
  });

  it("InvalidIpError's message names the offending input", async () => {
    const { lookupIp } = await import("./lookup");
    await expect(lookupIp("999.999.999.999")).rejects.toThrow(
      /999\.999\.999\.999/,
    );
  });

  it("empty string is also InvalidIpError (the route's own fast-path guard rejects it first, but lookupIp must too)", async () => {
    const { lookupIp, InvalidIpError } = await import("./lookup");
    await expect(lookupIp("")).rejects.toBeInstanceOf(InvalidIpError);
  });
});
