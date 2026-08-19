import { buildMmdb } from "./packages/collector/src/export/mmdb-writer.ts";
import { writeFileSync } from "node:fs";
import { Reader } from "maxmind";

const entries = [
  { network: "1.1.1.0/24", record: { asn: 13335, name: "CLOUDFLARENET", country: "AU", is_tor: false } },
  { network: "8.8.8.0/24", record: { asn: 15169, name: "GOOGLE", country: "US", is_tor: false } },
  { network: "10.0.0.0/8", record: { special: "Private-Use", rfc: "RFC1918" } },
  { network: "2606:4700::/44", record: { asn: 13335, name: "CLOUDFLARENET", country: "AU", is_tor: false } },
  { network: "171.25.193.25/32", record: { asn: 198093, is_tor: true, risk: 30, lat: 59.33 } },
];
const r = buildMmdb(entries, { databaseType: "IP-Insight-Engine-Test" });
console.log("nodes:", r.nodeCount, "records:", r.recordCount, "skipped:", r.skipped, "bytes:", r.buffer.length);
writeFileSync("/tmp/test.mmdb", r.buffer);

const reader = new Reader<Record<string, unknown>>(r.buffer);
for (const ip of ["1.1.1.1", "8.8.8.8", "10.5.5.5", "2606:4700::1", "171.25.193.25", "9.9.9.9"]) {
  console.log(ip, "->", JSON.stringify(reader.get(ip)));
}
