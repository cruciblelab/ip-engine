import { runBackup, listBackups, restoreBackup, loadCollectorConfig } from "@workspace/collector";

function fmtBytes(n: number | null): string {
  if (n === null) return "-";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

export async function runBackupCreate(): Promise<void> {
  const config = loadCollectorConfig();
  console.log(`Backing up to ${config.backupDir} ...`);
  const result = await runBackup(config);
  if (!result) {
    console.error("Backup failed — see the log for details.");
    process.exitCode = 1;
    return;
  }
  console.log(`Done: ${result.filePath} (${fmtBytes(result.sizeBytes)})`);
}

export async function runBackupList(): Promise<void> {
  const backups = await listBackups();
  if (backups.length === 0) {
    console.log("No backups yet.");
    return;
  }
  for (const b of backups) {
    const when = b.startedAt.toISOString();
    console.log(
      `${when}  ${b.status.padEnd(9)} ${fmtBytes(b.sizeBytes).padStart(8)}  ${b.filePath ?? "-"}${
        b.errorMessage ? `  ERROR: ${b.errorMessage}` : ""
      }`,
    );
  }
}

export async function runBackupRestore(filePath: string, confirmed: boolean): Promise<void> {
  if (!confirmed) {
    console.error(
      "This overwrites the current database with the backup's contents. Re-run with --yes to confirm.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Restoring from ${filePath} ...`);
  await restoreBackup(filePath);
  console.log("Restore complete.");
}
