import { useState } from "react"
import {
  useListBackups,
  getListBackupsQueryKey,
  useCreateBackup,
  useRestoreBackupEndpoint,
} from "@workspace/api-client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Archive, DatabaseBackup, AlertTriangle } from "lucide-react"
import { format } from "date-fns"
import { toast } from "@/hooks/use-toast"

function fmtBytes(n: number | null): string {
  if (n === null) return "-"
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const statusVariant = (status: string): "default" | "destructive" | "secondary" => {
  if (status === "completed") return "default"
  if (status === "failed") return "destructive"
  return "secondary"
}

export default function Backups() {
  const { data: backups, isLoading, refetch } = useListBackups({
    query: { queryKey: getListBackupsQueryKey(), refetchInterval: 10000 },
  })
  const createBackup = useCreateBackup()
  const restoreBackup = useRestoreBackupEndpoint()

  const [restoreTarget, setRestoreTarget] = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState("")

  const handleCreate = () => {
    createBackup.mutate(undefined, {
      onSuccess: (backup) => {
        toast({ title: "Backup created", description: `${backup.filePath ?? "snapshot"} (${fmtBytes(backup.sizeBytes)})` })
        refetch()
      },
      onError: (err) => {
        toast({
          title: "Backup failed",
          description: err instanceof Error ? err.message : "pg_dump may not be installed on this host.",
          variant: "destructive",
        })
      },
    })
  }

  const handleRestore = () => {
    if (!restoreTarget) return
    restoreBackup.mutate(
      { data: { filePath: restoreTarget, confirm: true } },
      {
        onSuccess: () => {
          toast({ title: "Restore complete", description: `Database restored from ${restoreTarget}` })
          setRestoreTarget(null)
          setConfirmText("")
        },
        onError: (err) => {
          toast({ title: "Restore failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" })
        },
      },
    )
  }

  return (
    <div className="p-6 md:p-8 md:pt-10 space-y-8 max-w-5xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight flex items-center gap-3">
            <Archive className="w-7 h-7 text-primary" /> Backups
          </h1>
          <p className="text-muted-foreground mt-2 text-sm md:text-base">
            <span className="font-mono">pg_dump</span> snapshots — manual, or automatic when the config's{" "}
            <span className="font-mono">backupEnabled</span> is on.
          </p>
        </div>
        <Button onClick={handleCreate} disabled={createBackup.isPending} className="font-mono">
          <DatabaseBackup className="w-4 h-4 mr-2" /> {createBackup.isPending ? "backing up…" : "backup_now"}
        </Button>
      </div>

      <Card className="border-border/60 shadow-none">
        <CardHeader>
          <CardTitle className="text-base font-medium">History</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading…</div>
          ) : !backups?.length ? (
            <div className="p-10 text-center text-sm text-muted-foreground">No backups yet.</div>
          ) : (
            <ul className="divide-y divide-border/60">
              {backups.map((b) => (
                <li key={b.id} className="px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant={statusVariant(b.status)} className="uppercase text-[10px]">
                        {b.status}
                      </Badge>
                      <span className="text-sm text-muted-foreground">{format(new Date(b.startedAt), "MMM d, HH:mm:ss")}</span>
                    </div>
                    <div className="font-mono text-xs text-muted-foreground mt-1 truncate max-w-md">
                      {b.filePath ?? b.errorMessage ?? "-"}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-mono text-sm text-foreground">{fmtBytes(b.sizeBytes)}</span>
                    {b.status === "completed" && b.filePath && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-destructive/40 text-destructive hover:bg-destructive/10 font-mono text-xs"
                        onClick={() => setRestoreTarget(b.filePath)}
                      >
                        restore
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={!!restoreTarget}
        onOpenChange={(open) => {
          if (!open) {
            setRestoreTarget(null)
            setConfirmText("")
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" /> Restore database?
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <span className="block">
                This overwrites everything currently in the database with the contents of{" "}
                <span className="font-mono text-foreground">{restoreTarget}</span>. There is no undo short of restoring a
                different backup.
              </span>
              <span className="block">
                Type <span className="font-mono font-semibold text-foreground">restore</span> to confirm.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="restore"
            className="font-mono"
            autoFocus
          />
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmText("")}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={confirmText !== "restore" || restoreBackup.isPending}
              onClick={handleRestore}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {restoreBackup.isPending ? "Restoring…" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
