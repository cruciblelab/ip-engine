/**
 * IP/ASN lookup — the opinionated query service layered on top of the raw
 * database @workspace/collector builds.
 * This is one reference implementation of "how to interpret this data"
 * (which layer wins on conflict, confidence scoring, usage classification,
 * anycast/geo/reverse-DNS enrichment at query time) — not the database
 * itself. A consumer who wants different resolution logic can ignore this
 * package entirely and query the tables @workspace/collector populates
 * directly.
 */
export * from "./lookup";
export * from "./config";
