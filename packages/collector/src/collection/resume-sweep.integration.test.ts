/**
 * Regression test for a real bug: `--resume` called immediately after a
 * crash (the most common time anyone calls it) used to report "nothing to
 * resume", because the row marking a crashed job as resumable
 * (`sweepOrphaned*Jobs`) only ran inside `startCollection`/`startEnrichment`
 * — never on the id-less `--resume` path, which resolves its default job
 * entirely through `listResumable*Jobs()` without calling either of those.
 * Fixed by sweeping inside `listResumable*Jobs()` itself. This test creates
 * a job stuck in "running" (simulating a crash — nothing set it to
 * "interrupted") and asserts it shows up as resumable without anything
 * else being called first.
 *
 * Requires a real Postgres reachable via DATABASE_URL (same one `pnpm
 * --filter @workspace/db run push` was run against) — skipped entirely
 * otherwise, since there is no meaningful way to fake this at the unit
 * level: the behavior under test *is* the query against real tables.
 */
import { afterEach, describe, expect, it } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("resume-sweep regression", () => {
  let cleanup: Array<() => Promise<unknown>> = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  it("listResumableCollectionJobs sweeps a crashed (still-'running') job into view", async () => {
    const { db, collectionJobsTable, collectionSourcesTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const { listResumableCollectionJobs } = await import("../collection/collector");

    const [job] = await db.insert(collectionJobsTable).values({ status: "running" }).returning();
    if (!job) throw new Error("insert failed");
    await db.insert(collectionSourcesTable).values({
      jobId: job.id,
      rir: "test-rir",
      url: "https://example.test/fake",
      status: "pending",
    });
    cleanup.push(async () => {
      await db.delete(collectionSourcesTable).where(eq(collectionSourcesTable.jobId, job.id));
      await db.delete(collectionJobsTable).where(eq(collectionJobsTable.id, job.id));
    });

    const resumable = await listResumableCollectionJobs();
    expect(resumable.some((r) => r.id === job.id)).toBe(true);

    const [row] = await db.select().from(collectionJobsTable).where(eq(collectionJobsTable.id, job.id));
    expect(row?.status).toBe("interrupted");
  });

  it("listResumableEnrichmentJobs sweeps a crashed (still-'running') job into view", async () => {
    const { db, enrichmentJobsTable, enrichmentSourcesTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const { listResumableEnrichmentJobs } = await import("../enrichment/enrichment");

    const [job] = await db.insert(enrichmentJobsTable).values({ status: "running" }).returning();
    if (!job) throw new Error("insert failed");
    await db.insert(enrichmentSourcesTable).values({
      jobId: job.id,
      sourceId: "test-source",
      kind: "test",
      status: "pending",
    });
    cleanup.push(async () => {
      await db.delete(enrichmentSourcesTable).where(eq(enrichmentSourcesTable.jobId, job.id));
      await db.delete(enrichmentJobsTable).where(eq(enrichmentJobsTable.id, job.id));
    });

    const resumable = await listResumableEnrichmentJobs();
    expect(resumable.some((r) => r.id === job.id)).toBe(true);

    const [row] = await db.select().from(enrichmentJobsTable).where(eq(enrichmentJobsTable.id, job.id));
    expect(row?.status).toBe("interrupted");
  });
});
