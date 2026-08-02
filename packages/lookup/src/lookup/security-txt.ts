/**
 * RFC 9116 `security.txt` — a supplementary, independent abuse-contact
 * signal, tried only when RDAP (rdap.ts) has no abuse-contact role for the
 * address. Unlike RDAP, this has nothing to do with any RIR: it's a file an
 * organisation publishes on its own domain, entirely at its own choice, with
 * no registry, no rate limit, and no redistribution terms to reason about —
 * see SOURCES.md.
 *
 * The tradeoff is coverage and indirection: this is domain-based, not
 * IP-based, so an IP has to resolve to a hostname first (reverse DNS), and
 * only organisations that chose to publish security.txt have one at all
 * (measured adoption is under 1-2% of domains, see SOURCES.md). It is
 * strictly a bonus signal, never the primary path.
 *
 * Same contract as reverse-dns.ts and rdap.ts: bounded by a timeout, never
 * throws, degrades to null on anything from "no PTR record" to "no
 * security.txt at either RFC 9116 location" to "the domain's server timed
 * out".
 */
import { sql } from "drizzle-orm";
import { db, abuseContactsTable } from "@workspace/db";
import { logger } from "@workspace/shared";
import { loadLookupConfig } from "../config";
import type { RdapAbuseContact } from "./rdap";

const SECURITY_TXT_CACHE_SOURCE = "security-txt";
const WELL_KNOWN_PATH = "/.well-known/security.txt";
const LEGACY_PATH = "/security.txt";

/**
 * Domain → result, for the lifetime of the process.
 *
 * The cache in `abuse_contacts` is keyed by network, and all this path can
 * honestly claim is the single address whose PTR led here — so without this,
 * 256 addresses in one /24 pointing at the same host would mean 256 separate
 * HTTPS requests to that organisation's web server for a file that is
 * identical every time. That is wasteful for us and indistinguishable from
 * scraping at the other end. Keyed by domain because that is the real
 * granularity of the underlying file.
 *
 * `null` is cached as deliberately as a hit: "this domain has no
 * security.txt" is the common case and re-checking it per address is exactly
 * the traffic worth avoiding.
 */
const domainCache = new Map<string, RdapAbuseContact | null>();
const DOMAIN_CACHE_MAX = 5_000;

/**
 * Best-effort registrable-domain guess from a PTR hostname: the last two
 * labels (`mail.google.com` -> `google.com`). Wrong for multi-part public
 * suffixes (`example.co.uk` -> the wrong `co.uk`), but the failure mode is
 * just "no security.txt found there either" — same as any other miss, never
 * a wrong answer surfaced to a caller.
 */
function guessRegistrableDomain(hostname: string): string | null {
  const labels = hostname.replace(/\.$/, "").split(".");
  if (labels.length < 2) return null;
  return labels.slice(-2).join(".");
}

async function fetchSecurityTxtBody(domain: string, timeoutMs: number): Promise<string | null> {
  for (const path of [WELL_KNOWN_PATH, LEGACY_PATH]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`https://${domain}${path}`, { signal: controller.signal });
      if (response.ok) return await response.text();
    } catch {
      // try the next location
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** First `Contact:` line's value, per RFC 9116 — `mailto:`/`tel:` schemes
 * unwrapped to a bare address, anything else (usually an `https:` report
 * form) kept as-is since there's no better field to put it in. */
function parseContact(body: string): { email: string | null; contact: string | null } {
  let email: string | null = null;
  let firstContact: string | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^Contact:\s*(.+)$/i.exec(line);
    if (!match) continue;
    const value = match[1]!.trim();
    firstContact ??= value;
    if (!email && value.toLowerCase().startsWith("mailto:")) {
      email = value.slice("mailto:".length);
    }
  }
  return { email, contact: firstContact };
}

async function cacheSecurityTxtContact(network: string, contact: RdapAbuseContact): Promise<void> {
  await db
    .insert(abuseContactsTable)
    .values({
      network,
      email: contact.email,
      phone: contact.phone,
      org: contact.org,
      source: SECURITY_TXT_CACHE_SOURCE,
    })
    .onConflictDoUpdate({
      target: [abuseContactsTable.network, abuseContactsTable.source],
      set: {
        email: sql`excluded.email`,
        phone: sql`excluded.phone`,
        org: sql`excluded.org`,
        ingestedAt: sql`now()`,
      },
    });
}

/**
 * Called only on a cache miss for both the primary abuse_contacts table and
 * RDAP (see lookup.ts).
 *
 * `hostname` is the PTR record the caller has *already* resolved — this
 * deliberately does not look it up itself, because `lookupIp` resolves
 * reverse DNS for every request anyway and repeating it here would mean two
 * DNS round trips for one answer. A caller with no hostname has nothing for
 * this path to work from and should not call it.
 *
 * Persisted against the single `/32` (or `/128`) it resolved rather than a
 * prefix: unlike RDAP there is no registry object here to read a covering
 * CIDR from, and claiming a whole network's contact on the strength of one
 * address's PTR would be inventing coverage this doesn't have.
 */
export async function fetchAbuseContactViaSecurityTxt(
  ip: string,
  hostname: string | null,
): Promise<RdapAbuseContact | null> {
  if (!hostname) return null;
  const domain = guessRegistrableDomain(hostname);
  if (!domain) return null;

  if (domainCache.has(domain)) return domainCache.get(domain) ?? null;

  const timeoutMs = loadLookupConfig().securityTxtTimeoutMs;
  const body = await fetchSecurityTxtBody(domain, timeoutMs);
  const { email, contact } = body ? parseContact(body) : { email: null, contact: null };
  const result: RdapAbuseContact | null =
    email || contact ? { email, phone: null, org: email ? null : contact } : null;

  // Crude bound rather than a real LRU: this only ever holds one small object
  // per domain, and the eviction policy matters far less than not growing
  // without limit in a long-lived server process.
  if (domainCache.size >= DOMAIN_CACHE_MAX) domainCache.clear();
  domainCache.set(domain, result);

  if (result) {
    const network = `${ip}/${ip.includes(":") ? 128 : 32}`;
    void cacheSecurityTxtContact(network, result).catch((err) =>
      logger.debug({ err, network }, "security.txt cache write failed"),
    );
  }
  return result;
}
