/**
 * Formatting/parsing for collect/enrich job ids, shared so both packages
 * render and accept the exact same "sequential" shape
 * (`collect-000123`/`enrich-000123`) instead of each rolling its own
 * regex/padding. The real primary key is always the table's uuid `id`
 * column — this only controls what gets displayed and what
 * `--resume <ref>` is allowed to type instead of the uuid.
 */
export type JobIdFormat = "uuid" | "sequential";

export function formatJobDisplayId(
  prefix: string,
  seq: number,
  format: JobIdFormat,
  uuidId: string,
): string {
  if (format === "sequential") return `${prefix}-${String(seq).padStart(6, "0")}`;
  return uuidId;
}

/** Returns the `seq` number if `ref` matches `<prefix>-NNNNNN`, else null (caller falls back to treating `ref` as a uuid). */
export function parseSequentialJobRef(prefix: string, ref: string): number | null {
  const match = new RegExp(`^${prefix}-(\\d+)$`).exec(ref);
  return match ? Number(match[1]) : null;
}
