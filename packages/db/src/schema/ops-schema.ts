import { pgSchema } from "drizzle-orm/pg-core";

/**
 * `ops` — the Postgres schema holding everything about *building* the
 * database, kept out of `public` which holds only the data worth querying.
 *
 * The split exists because this project's whole point is that the database
 * is portable: someone should be able to take it into their own project and
 * understand it. Mixing job history, per-source download progress, and
 * backup bookkeeping in with the address-space tables roughly doubled the
 * table count a newcomer had to read past before finding anything they
 * could query. Now `\dt` in `public` lists only queryable data, and `\dt
 * ops.*` lists the machinery.
 *
 * Nothing here is needed to answer a question about an IP address. A
 * consumer can ignore this schema entirely — or drop it — without affecting
 * a single lookup.
 */
export const opsSchema = pgSchema("ops");
