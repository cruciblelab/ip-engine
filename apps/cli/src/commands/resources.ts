import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadCollectorConfig, buildResourceReport, type ResourceReport } from "@workspace/collector";

const execFileAsync = promisify(execFile);

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

interface ProcRow {
  pid: string;
  cpu: string;
  mem: string;
  rss: string;
  command: string;
}

/** Best-effort `ps aux` snapshot of node/postgres processes — the two things
 * that actually consume CPU/RAM while a collect/enrich job runs. `ps`'s
 * column set/flags aren't identical everywhere (Termux's toybox ps is not
 * full util-linux), so a parse failure here is reported, not thrown: this
 * is a diagnostic extra, not something the rest of the command depends on. */
async function listRelevantProcesses(): Promise<{ rows: ProcRow[]; error?: string }> {
  try {
    const { stdout } = await execFileAsync("ps", ["aux"]);
    const lines = stdout.split("\n").slice(1); // drop header
    const rows: ProcRow[] = [];
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 11) continue;
      const [, pid, cpu, mem, , rss, , , , , ...rest] = cols;
      const command = rest.join(" ");
      if (!/node|postgres/i.test(command)) continue;
      if (/\bps\s+aux\b/i.test(command)) continue;
      rows.push({ pid: pid ?? "?", cpu: cpu ?? "?", mem: mem ?? "?", rss: rss ?? "0", command });
    }
    return { rows };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runResources(opts: { json?: boolean }): Promise<void> {
  const config = loadCollectorConfig();
  const report = await buildResourceReport(config);
  const { rows: procRows, error: procError } = await listRelevantProcesses();

  const system = {
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    loadAvg: os.loadavg(),
    cpuCount: os.cpus().length,
  };

  if (opts.json) {
    console.log(JSON.stringify({ report, system, processes: procRows }, null, 2));
    return;
  }

  printReport(report, system, procRows, procError);
}

function printReport(
  report: ResourceReport,
  system: { totalMemBytes: number; freeMemBytes: number; loadAvg: number[]; cpuCount: number },
  procRows: ProcRow[],
  procError: string | undefined,
): void {
  console.log(`Database: ${fmtBytes(report.databaseBytes)} total\n`);
  console.log("Largest tables/materialized views:");
  for (const r of report.relations.slice(0, 15)) {
    const label = `${r.schema}.${r.name}${r.kind === "materialized view" ? " (materialized)" : ""}`;
    console.log(`  ${label.padEnd(40)} ${fmtBytes(r.bytes).padStart(10)}`);
  }
  if (report.relations.length > 15) {
    console.log(`  ... and ${report.relations.length - 15} more (use --json for the full list)`);
  }

  console.log("\nLog files:");
  for (const f of report.logFiles) {
    console.log(`  ${f.path.padEnd(50)} ${f.exists ? fmtBytes(f.bytes).padStart(10) : "(not created yet)"}`);
  }

  console.log("\nBackups:");
  console.log(
    report.backupDirBytes === null
      ? "  No backup directory yet."
      : `  ${report.backupFileCount} file(s), ${fmtBytes(report.backupDirBytes)} total`,
  );

  console.log("\nSystem:");
  const usedMem = system.totalMemBytes - system.freeMemBytes;
  console.log(
    `  RAM: ${fmtBytes(usedMem)} used / ${fmtBytes(system.totalMemBytes)} total ` +
      `(${((usedMem / system.totalMemBytes) * 100).toFixed(0)}%)`,
  );
  console.log(
    `  Load average (1m/5m/15m): ${system.loadAvg.map((n) => n.toFixed(2)).join(" / ")} (${system.cpuCount} CPU(s))`,
  );

  console.log("\nRunning node/postgres processes:");
  if (procError) {
    console.log(`  Couldn't run \`ps aux\` (${procError}) — skipping.`);
  } else if (procRows.length === 0) {
    console.log("  None found (or `ps aux` returned nothing usable).");
  } else {
    for (const p of procRows) {
      console.log(
        `  pid ${p.pid.padEnd(8)} cpu ${p.cpu.padStart(5)}%  mem ${p.mem.padStart(5)}%  rss ${fmtBytes(
          Number(p.rss) * 1024,
        ).padStart(10)}  ${p.command.slice(0, 80)}`,
      );
    }
  }
}
