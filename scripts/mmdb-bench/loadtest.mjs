#!/usr/bin/env node
// Concurrency-ramp load test for server.mjs. Accepts either one target URL
// or a comma-separated list (server.mjs --cluster prints the exact list to
// paste here, since it gives each worker its own port rather than sharing
// one — see that file's header for why). Requests are spread randomly
// across whatever targets are given, so a multi-port cluster run actually
// exercises every worker instead of hammering just the first one.
//
// Uses node:http with an explicit Agent, not the global fetch() — verified
// directly (2026-08-07): fetch() against this same server collapsed past
// concurrency=5 (929 -> 74 -> 256 req/s, latency spiking past 1s) purely
// from undici's own connection-pool queuing, not the server's real
// capacity. An http.Agent with maxSockets sized to the concurrency level
// does not have that problem.
//
// Usage:
//   node loadtest.mjs [baseUrl(s), comma-separated] ["concurrency,levels"] [windowMs]
//   node loadtest.mjs http://127.0.0.1:8199 1,5,10,25,50,100,200,400 5000
//   node loadtest.mjs "http://127.0.0.1:8199,http://127.0.0.1:8200,..." 1,5,10,25,50,100,200,400 5000
import http from "node:http";
import https from "node:https";
import os from "node:os";

const targets = (process.argv[2] ?? process.env.TARGET ?? "http://127.0.0.1:8199")
  .split(",")
  .map((s) => new URL(s.trim()));
const levels = (process.argv[3] ?? "1,5,10,25,50,100,200,400")
  .split(",")
  .map((s) => Number(s.trim()));
const windowMs = Number(process.argv[4] ?? 5000);
const warmupMs = 500;

function randomIp() {
  // Scattered public-looking IPv4s, not private/reserved-heavy: avoids the
  // benchmark accidentally measuring "how fast is a guaranteed miss."
  const first = 1 + Math.floor(Math.random() * 223);
  const rest = () => Math.floor(Math.random() * 256);
  return `${first}.${rest()}.${rest()}.${rest()}`;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function get(agents) {
  const url = targets[Math.floor(Math.random() * targets.length)];
  const transport = url.protocol === "https:" ? https : http;
  const agent = agents.get(url.protocol === "https:" ? "https" : "http");
  return new Promise((resolve, reject) => {
    const req = transport.get(
      { hostname: url.hostname, port: url.port, path: `/lookup/${randomIp()}`, agent },
      (res) => {
        res.on("data", () => {}); // drain body, matches a real client
        res.on("end", () => resolve(res.statusCode));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
  });
}

async function runLevel(concurrency) {
  // One Agent per transport (http/https), shared across all targets — the
  // Agent buckets sockets by host:port internally, so maxSockets still
  // applies per-target even though one Agent object serves every target.
  const agents = new Map([
    ["http", new http.Agent({ keepAlive: true, maxSockets: concurrency })],
    ["https", new https.Agent({ keepAlive: true, maxSockets: concurrency })],
  ]);
  let completed = 0;
  let errors = 0;
  let latencies = [];
  let stop = false;

  async function worker() {
    while (!stop) {
      const t0 = performance.now();
      try {
        const status = await get(agents);
        const dt = performance.now() - t0;
        if (status && status < 400) {
          completed++;
          latencies.push(dt);
        } else {
          errors++;
        }
      } catch {
        errors++;
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());

  // Warmup, not counted — the first requests at a new concurrency level pay
  // connection-setup cost the steady state doesn't.
  await new Promise((r) => setTimeout(r, warmupMs));
  completed = 0;
  errors = 0;
  latencies = [];

  const started = performance.now();
  await new Promise((r) => setTimeout(r, windowMs));
  stop = true;
  await Promise.all(workers);
  const elapsedSec = (performance.now() - started) / 1000;
  for (const agent of agents.values()) agent.destroy();

  latencies.sort((a, b) => a - b);
  return {
    concurrency,
    rps: Math.round(completed / elapsedSec),
    completed,
    errors,
    p50: percentile(latencies, 50).toFixed(1),
    p95: percentile(latencies, 95).toFixed(1),
    p99: percentile(latencies, 99).toFixed(1),
  };
}

async function main() {
  console.log(`Targets (${targets.length}): ${targets.map((u) => u.href).join(", ")}`);
  console.log(`CPU cores reported by os.cpus(): ${os.cpus().length || "0 (Termux/Android often can't read this — not a real zero)"}`);
  console.log(`Concurrency levels: ${levels.join(", ")}, ${windowMs}ms each\n`);

  const results = [];
  for (const c of levels) {
    const r = await runLevel(c);
    results.push(r);
    console.log(
      `concurrency=${String(r.concurrency).padStart(4)}  rps=${String(r.rps).padStart(6)}  ` +
        `p50=${r.p50}ms  p95=${r.p95}ms  p99=${r.p99}ms  errors=${r.errors}`,
    );
  }

  const best = results.reduce((a, b) => (b.rps > a.rps ? b : a));
  console.log(`\nPeak: ${best.rps} req/s at concurrency=${best.concurrency}`);
  const last = results[results.length - 1];
  if (last.rps < best.rps * 0.9) {
    console.log(
      `Note: throughput dropped past the peak (last level ${last.rps} req/s vs peak ${best.rps} req/s) — ` +
        `saturation point already found, no need to push concurrency higher.`,
    );
  } else {
    console.log(
      `Note: throughput was still rising or flat at the highest tested concurrency — ` +
        `the real ceiling may be higher than what was tested. Try higher levels, ` +
        `e.g. node loadtest.mjs "${process.argv[2] ?? ""}" ${levels[levels.length - 1] * 2},${levels[levels.length - 1] * 4}`,
    );
  }
}

main();
