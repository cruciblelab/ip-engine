#!/usr/bin/env node
// Minimal HTTP lookup server over a built .mmdb file. Purpose-built for
// load-testing raw mmdb-serving throughput, not a product server — no
// logging, no framework, no extra middleware on the hot path, so the
// benchmark measures the mmdb read path itself rather than overhead this
// script adds on top of it.
//
// Deliberately single-process, no node:cluster. Tried twice on the phone
// this was built for (Termux/Android, Node v24) — both of Node's built-in
// multi-worker-on-one-port modes (SCHED_RR and SCHED_NONE) failed with
// `bind EADDRINUSE null:<port>`, and even giving each worker its own
// distinct port still hit the same error intermittently for one worker out
// of eight, which points at a bug in Node's cluster IPC/handle-registration
// itself on this platform, not anything fixable from here. Multi-core
// testing is done instead by launching N independent copies of this same
// single-process server directly from the shell, one per port — no shared
// Node subsystem involved, so nothing here can race or collide:
//
//   for i in 0 1 2 3 4 5 6 7; do
//     node server.mjs ~/current.mmdb $((8199+i)) > ~/bench-worker-$i.log 2>&1 &
//   done
//
// Usage: node server.mjs [path/to/file.mmdb] [port]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import os from "node:os";
import { Reader } from "maxmind";

const mmdbPath = process.argv[2] ?? process.env.MMDB_PATH ?? `${os.homedir()}/current.mmdb`;
const port = Number(process.argv[3] ?? process.env.PORT ?? 8199);

const buffer = readFileSync(mmdbPath);
const reader = new Reader(buffer);
console.log(`[pid ${process.pid}] loaded ${mmdbPath} (${(buffer.length / 1e6).toFixed(1)} MB)`);

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  const match = req.url?.match(/^\/lookup\/(.+)$/);
  if (!match) {
    res.writeHead(404).end();
    return;
  }
  let result;
  try {
    result = reader.get(decodeURIComponent(match[1]));
  } catch {
    res.writeHead(400).end();
    return;
  }
  const body = JSON.stringify(result ?? {});
  res.writeHead(200, { "content-type": "application/json" }).end(body);
});

server.listen(port, () => {
  console.log(`[pid ${process.pid}] listening on :${port}`);
});
