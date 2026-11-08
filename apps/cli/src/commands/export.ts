import fs from "node:fs";
import { streamIpBlocksCsv, streamAsnBlocksCsv, streamBlocksNdjson } from "@workspace/collector";

export async function runExport(opts: { format: "csv" | "ndjson"; out?: string }): Promise<void> {
  const sink = opts.out ? fs.createWriteStream(opts.out) : process.stdout;
  if (opts.format === "csv") {
    await streamIpBlocksCsv(sink);
    await streamAsnBlocksCsv(sink);
  } else {
    await streamBlocksNdjson(sink);
  }
  if (opts.out) {
    await new Promise<void>((resolve, reject) => {
      (sink as fs.WriteStream).end((err?: Error) => (err ? reject(err) : resolve()));
    });
    console.error(`Wrote export to ${opts.out}`);
  }
}
