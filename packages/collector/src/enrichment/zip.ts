/**
 * Single-entry ZIP extraction (GeoNames' export files: cities5000.zip
 * etc. are always exactly one entry).
 *
 * An earlier hand-rolled version of this file assumed ZIP local file
 * headers always carry the compressed size upfront — they don't. GeoNames'
 * archives use the streaming/data-descriptor variant (size written *after*
 * the compressed data, general-purpose flag bit 3 set), which needs a real
 * ZIP reader to handle correctly. `yauzl` is small, pure JS (no native
 * binding — no Termux/arm64 surprises), and this is exactly the kind of
 * binary-format edge case not worth re-deriving by hand.
 */
import yauzl from "yauzl";

export interface ZipEntry {
  filename: string;
  content: Buffer;
}

export function extractSingleEntryZip(buffer: Buffer): Promise<ZipEntry> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error("Failed to open ZIP buffer"));
        return;
      }
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          // Directory entry — skip (shouldn't occur in GeoNames archives).
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            reject(streamErr ?? new Error("Failed to open ZIP entry stream"));
            return;
          }
          const chunks: Buffer[] = [];
          readStream.on("data", (chunk: Buffer) => chunks.push(chunk));
          readStream.on("end", () => {
            zipfile.close();
            resolve({ filename: entry.fileName, content: Buffer.concat(chunks) });
          });
          readStream.on("error", reject);
        });
      });
      zipfile.on("error", reject);
    });
  });
}
