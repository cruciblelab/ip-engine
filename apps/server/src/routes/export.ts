/**
 * Streaming exports of the ingested database over HTTP. The actual query
 * logic lives in @workspace/collector's export.ts, shared with the CLI so a
 * terminal export and an HTTP export produce byte-identical output.
 */
import { Router, type IRouter } from "express";
import {
  streamIpBlocksCsv,
  streamAsnBlocksCsv,
  streamBlocksNdjson,
} from "@workspace/collector";

const router: IRouter = Router();

router.get("/export/blocks.csv", async (_req, res): Promise<void> => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="rir-blocks-${Date.now()}.csv"`,
  );
  await streamIpBlocksCsv(res);
  await streamAsnBlocksCsv(res);
  res.end();
});

router.get("/export/blocks.json", async (_req, res): Promise<void> => {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="rir-blocks-${Date.now()}.ndjson"`,
  );
  await streamBlocksNdjson(res);
  res.end();
});

export default router;
