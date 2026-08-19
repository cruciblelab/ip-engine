/**
 * Reverse DNS (PTR) resolution — last-ditch classification tiebreaker.
 *
 * Unlike the RIPE Stat ASN lookup this replaced, a PTR query isn't a
 * rate-limited third-party HTTP API — it's a plain DNS lookup through
 * whatever resolver the host already trusts, typically answered in a few
 * ms. Still never allowed to block or fail the main lookup: bounded by a
 * short timeout and always resolves (null on any error), matching every
 * other "best-effort" resolver in this codebase.
 */
import { promises as dns } from "node:dns";
import { logger } from "@workspace/shared";
import { loadLookupConfig } from "../config";

export async function reverseDnsLookup(ip: string): Promise<string | null> {
  const timeoutMs = loadLookupConfig().reverseDnsTimeoutMs;
  try {
    const hostnames = await Promise.race([
      dns.reverse(ip),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("PTR lookup timed out")), timeoutMs);
      }),
    ]);
    return hostnames[0] ?? null;
  } catch (err) {
    logger.debug({ err, ip }, "Reverse DNS lookup failed — degraded gracefully");
    return null;
  }
}
