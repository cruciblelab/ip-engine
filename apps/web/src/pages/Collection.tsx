import {
  useGetCollectionStatus,
  getGetCollectionStatusQueryKey,
  useStartCollection,
  useStopCollection,
  useListCollectionJobs,
  getListCollectionJobsQueryKey,
} from "@workspace/api-client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Play, Square, Activity } from "lucide-react"
import { format } from "date-fns"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const statusVariant = (status: string): "default" | "destructive" | "secondary" | "outline" => {
  if (status === "completed") return "default"
  if (status === "failed" || status === "interrupted") return "destructive"
  if (status === "completed_with_errors") return "outline"
  return "secondary"
}

export default function Collection() {
  const { data: status, refetch } = useGetCollectionStatus({
    query: { queryKey: getGetCollectionStatusQueryKey(), refetchInterval: 3000 },
  })
  const { data: jobs } = useListCollectionJobs({
    query: { queryKey: getListCollectionJobsQueryKey(), refetchInterval: 10000 },
  })
  const startJob = useStartCollection()
  const stopJob = useStopCollection()

  const handleStart = () => startJob.mutate({}, { onSuccess: () => refetch() })
  const handleStop = () => stopJob.mutate(undefined, { onSuccess: () => refetch() })

  return (
    <div className="p-6 md:p-8 md:pt-10 space-y-8 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Data Collection</h1>
          <p className="text-muted-foreground mt-2 text-sm md:text-base">Manage bulk downloads from Regional Internet Registries.</p>
        </div>
        <div className="flex items-center gap-3">
          {status?.isActive ? (
            <Button variant="destructive" onClick={handleStop} disabled={stopJob.isPending} className="font-mono">
              <Square className="w-4 h-4 mr-2" /> stop_collection
            </Button>
          ) : (
            <Button onClick={handleStart} disabled={startJob.isPending} className="font-mono">
              <Play className="w-4 h-4 mr-2" /> start_collection
            </Button>
          )}
        </div>
      </div>

      {status?.isActive && (
        <Card className="border-primary/40 bg-primary/[0.04] shadow-none ring-1 ring-primary/20">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary animate-pulse" />
              <CardTitle className="text-base font-medium">Active Ingest Job</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-8">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="space-y-1">
                <span className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Ingested</span>
                <div className="text-2xl font-mono text-primary">{status.job?.totalIngested.toLocaleString() || 0}</div>
              </div>
              <div className="space-y-1">
                <span className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Rate</span>
                <div className="text-2xl font-mono">
                  {status.ratePerSecond?.toFixed(0) || 0} <span className="text-sm text-muted-foreground">r/s</span>
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Status</span>
                <div>
                  <Badge className="bg-primary/15 text-primary hover:bg-primary/20 uppercase">{status.job?.status}</Badge>
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Started</span>
                <div className="text-lg font-mono">{status.job?.startedAt ? format(new Date(status.job.startedAt), "HH:mm:ss") : "-"}</div>
              </div>
            </div>

            <div className="space-y-4">
              {status.sources.map((source) => (
                <div key={source.rir} className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="font-semibold uppercase tracking-widest text-foreground">{source.rir}</span>
                    <span className="font-mono text-muted-foreground">
                      <span className="uppercase text-xs mr-3 text-primary">{source.status}</span>
                      {(source.bytesDownloaded / 1024 / 1024).toFixed(2)} MB
                    </span>
                  </div>
                  <Progress
                    value={source.status === "completed" ? 100 : source.status === "downloading" || source.status === "parsing" ? 50 : 0}
                    className="h-1.5 bg-primary/10"
                  />
                  <div className="flex gap-4 text-xs font-mono text-muted-foreground/70">
                    <span>V4:{source.ipv4Count.toLocaleString()}</span>
                    <span>V6:{source.ipv6Count.toLocaleString()}</span>
                    <span>AS:{source.asnCount.toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-border/60 shadow-none">
        <CardHeader>
          <CardTitle className="text-base font-medium">Job History</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="border-border/60">
                <TableHead className="uppercase text-xs font-semibold tracking-wider">Job ID</TableHead>
                <TableHead className="uppercase text-xs font-semibold tracking-wider">Status</TableHead>
                <TableHead className="uppercase text-xs font-semibold tracking-wider">Started At</TableHead>
                <TableHead className="uppercase text-xs font-semibold tracking-wider">Duration</TableHead>
                <TableHead className="uppercase text-xs font-semibold tracking-wider text-right">Ingested</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs?.map((job) => (
                <TableRow key={job.id} className="border-border/60">
                  <TableCell className="font-mono text-xs text-muted-foreground">{job.id.substring(0, 8)}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(job.status)} className="uppercase text-[10px]">
                      {job.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">{format(new Date(job.startedAt), "MMM d, HH:mm:ss")}</TableCell>
                  <TableCell className="font-mono text-sm">{job.durationMs ? `${(job.durationMs / 1000).toFixed(1)}s` : "-"}</TableCell>
                  <TableCell className="text-right font-mono text-primary">{job.totalIngested.toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {!jobs?.length && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                    No jobs found in history.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
