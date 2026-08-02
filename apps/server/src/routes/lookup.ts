import { Router, type Request, type Response } from "express";
import {
  lookupIp,
  lookupBulk,
  lookupAsn,
  lookupCache,
  checkPrefix,
  PrefixCheckInputError,
} from "@workspace/lookup";
import { logger } from "@workspace/shared";

const router: Router = Router();

const BULK_MAX = 1000;

/**
 * GET /api/lookup/ip/:ip — single IP lookup. Hot path target: <5ms cached,
 * <20ms cold. Response shape is documented in packages/api-spec/openapi.yaml.
 */
router.get("/ip/:ip", async (req: Request, res: Response) => {
  const ip = String(req.params["ip"] ?? "");
  if (!ip) {
    res.status(400).json({ error: "ip path parameter required" });
    return;
  }
  const start = process.hrtime.bigint();
  try {
    const result = await lookupIp(ip);
    const latencyMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    res.json({ ...result, latencyMs });
  } catch (err) {
    res
      .status(400)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /api/lookup/bulk — body: { ips: string[] } (max 1000 per request).
 * Results are returned in the same order as input.
 */
router.post("/bulk", async (req: Request, res: Response) => {
  const body = req.body as { ips?: unknown };
  if (!body || !Array.isArray(body.ips)) {
    res.status(400).json({ error: "body.ips must be an array of strings" });
    return;
  }
  const ips = (body.ips as unknown[]).map((x) => String(x));
  if (ips.length === 0) {
    res.json({ count: 0, latencyMs: 0, results: [] });
    return;
  }
  if (ips.length > BULK_MAX) {
    res
      .status(400)
      .json({ error: `Too many IPs in one request (max ${BULK_MAX})` });
    return;
  }
  const start = process.hrtime.bigint();
  const results = await lookupBulk(ips);
  const latencyMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  res.json({ count: results.length, latencyMs, results });
});

/**
 * GET /api/lookup/asn/:asn — Autonomous System lookup with the org name
 * and ASN type (hosting / isp / mobile / enterprise / cdn / other).
 */
router.get("/asn/:asn", async (req: Request, res: Response) => {
  const raw = String(req.params["asn"] ?? "").replace(/^as/i, "");
  const asn = Number(raw);
  if (!Number.isFinite(asn) || asn <= 0) {
    res
      .status(400)
      .json({ error: "asn path parameter must be a positive integer" });
    return;
  }
  const start = process.hrtime.bigint();
  const result = await lookupAsn(asn);
  const latencyMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  if (!result) {
    res.status(404).json({ found: false, asn, latencyMs });
    return;
  }
  res.json({ found: true, ...result, latencyMs });
});

/** GET /api/lookup/cache/stats — observability for the LRU cache. */
router.get("/cache/stats", (_req: Request, res: Response) => {
  res.json(lookupCache.stats());
});

/**
 * POST /api/lookup/self-check — body: { prefix: "203.0.113.0/24" }. The
 * free, no-account operator report card (roadmap item 7): geofeed, RPKI,
 * abuse contact, reverse DNS for the caller's own prefix. Takes a body
 * rather than a path param because a CIDR contains "/".
 */
router.post("/self-check", async (req: Request, res: Response) => {
  const body = req.body as { prefix?: unknown };
  const prefix = typeof body?.prefix === "string" ? body.prefix : "";
  if (!prefix) {
    res.status(400).json({ error: "body.prefix must be a CIDR string, e.g. 203.0.113.0/24" });
    return;
  }
  try {
    const report = await checkPrefix(prefix);
    res.json(report);
  } catch (err) {
    // Input errors carry a message written for the caller; anything else is
    // an infrastructure failure whose details (SQL text, connection strings)
    // belong in the log, not in a public endpoint's response.
    if (err instanceof PrefixCheckInputError) {
      res.status(400).json({ error: err.message });
      return;
    }
    logger.error({ err, prefix }, "self-check failed");
    res.status(500).json({ error: "self-check failed — try again later" });
  }
});

export default router;
