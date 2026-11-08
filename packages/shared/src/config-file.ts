/**
 * Shared plumbing for reading `ip-insight.config.json` — the file itself,
 * `parseList`/`validateAgainstKnown` helpers, used by both
 * `@workspace/collector` (what to collect/enrich) and `@workspace/lookup`
 * (which lookup features to compute). Kept here, not in either package,
 * because collector and lookup are deliberately independent of each other
 * (see @workspace/collector's own header comment) — this is the one bit
 * both legitimately need, and it has zero opinion of its own about what
 * the file's keys mean.
 */
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";

export function resolveConfigPath(): string {
  return resolveNamedJsonPath("IP_INSIGHT_CONFIG", "ip-insight.config.json");
}

/**
 * Resolves the path for any of this project's JSON side-files: an env var
 * naming an explicit path, else `<filename>` in the current working
 * directory. Shared by `resolveConfigPath` (ip-insight.config.json) and
 * `@workspace/collector`'s sources registry (sources.registry.json) so both
 * follow the exact same "env var, else cwd" convention.
 */
export function resolveNamedJsonPath(envVar: string, filename: string): string {
  return process.env[envVar]
    ? path.resolve(process.env[envVar]!)
    : path.resolve(process.cwd(), filename);
}

/**
 * Reads and JSON-parses an arbitrary JSON file, or returns `null` if it
 * doesn't exist (not an error — an absent override file just means "use
 * defaults"). Throws on a malformed file rather than silently ignoring it,
 * so a broken file doesn't look like "no override" to whoever's debugging
 * why a setting didn't apply.
 */
export function readNamedJsonFile(
  filePath: string,
  errorLabel: string,
): { obj: Record<string, unknown>; sourcePath: string } | null {
  if (!fs.existsSync(filePath)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(
      `${errorLabel}: failed to parse ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${errorLabel}: ${filePath} must contain a JSON object`);
  }
  return { obj: raw as Record<string, unknown>, sourcePath: filePath };
}

/**
 * Reads and JSON-parses the config file, or returns `null` if it doesn't
 * exist (not an error — every key is then simply absent). Throws on a
 * malformed file rather than silently ignoring it, so a broken config
 * doesn't look like "no config" to whoever's debugging why a setting
 * didn't apply.
 */
export function readConfigFile(): { obj: Record<string, unknown>; sourcePath: string } | null {
  return readNamedJsonFile(resolveConfigPath(), "ip-insight config");
}

/**
 * A key's value is either absent/empty, the literal `allKeyword` (meaning
 * "everything" — `null`), or a comma-separated list.
 */
export function parseListValue(
  raw: unknown,
  key: string,
  allKeyword: string,
): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new Error(`ip-insight config: "${key}" must be a string, got ${typeof raw}`);
  }
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === allKeyword) return null;
  return trimmed.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Filters out (and warns about) ids that aren't in `knownIds`, rather than failing the whole config. */
export function validateAgainstKnown(
  ids: string[] | null,
  knownIds: string[],
  key: string,
): string[] | null {
  if (ids === null) return null;
  const known = new Set(knownIds);
  const valid = ids.filter((id) => known.has(id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    logger.warn(
      { key, unknown, known: knownIds },
      `ip-insight config: unrecognized "${key}" id(s) ignored: ${unknown.join(", ")}`,
    );
  }
  return valid;
}

/**
 * A numeric tuning knob (batch sizes, timeouts, concurrency, cache sizes,
 * retry counts). Absent → `fallback`. Throws on a non-integer or a value
 * outside `[min, max]` rather than silently clamping — a typo'd config
 * value should fail loudly, not quietly turn into some other number.
 */
export function parseNumberValue(
  raw: unknown,
  key: string,
  fallback: number,
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new Error(`ip-insight config: "${key}" must be an integer, got ${JSON.stringify(raw)}`);
  }
  if (raw < min || raw > max) {
    throw new Error(`ip-insight config: "${key}" must be between ${min} and ${max}, got ${raw}`);
  }
  return raw;
}

/** A key whose value must be one of a fixed set of string literals, e.g. an export format. */
export function parseEnumValue<T extends string>(
  raw: unknown,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    throw new Error(
      `ip-insight config: "${key}" must be one of ${allowed.join("/")}, got ${JSON.stringify(raw)}`,
    );
  }
  return raw as T;
}

/** A key whose value is a plain string used as-is (e.g. a directory path). */
export function parseStringValue(raw: unknown, key: string, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "string") {
    throw new Error(`ip-insight config: "${key}" must be a string, got ${typeof raw}`);
  }
  return raw;
}

/** An on/off toggle (checkpointing, backups, sleep mode, etc). */
export function parseBooleanValue(raw: unknown, key: string, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "boolean") {
    throw new Error(`ip-insight config: "${key}" must be a boolean, got ${JSON.stringify(raw)}`);
  }
  return raw;
}
