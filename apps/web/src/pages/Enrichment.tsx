import {
  useGetEnrichmentStatus,
  getGetEnrichmentStatusQueryKey,
  useStartEnrichment,
  useStopEnrichment,
  useListEnrichmentJobs,
  getListEnrichmentJobsQueryKey,
  useGetEnrichmentStats,
  getGetEnrichmentStatsQueryKey,
} from "@workspace/api-client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Play, Square, Activity, Shield, Cloud } from "lucide-react"
import { format } from "date-fns"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const statusVariant = (status: string): "default" | "destructive" | "secondary" | "outline" => {
  if (status === "completed") return "default"
  if (status === "failed" || status === "interrupted") return "destructive"
  if (status === "completed_with_errors") return "outline"
  return "secondary"
}

export default function Enrichment() {
  const { data: status, refetch } = useGetEnrichmentStatus({
    query: { queryKey: getGetEnrichmentStatusQueryKey(), refetchInterval: 3000 },
  })
  const { data: jobs } = useListEnrichmentJobs({
    query: { queryKey: getListEnrichmentJobsQueryKey(), refetchInterval: 10000 },
  })
  const { data: stats } = useGetEnrichmentStats({ query: { queryKey: getGetEnrichmentStatsQueryKey() } })
  const startJob = useStartEnrichment()
  const stopJob = useStopEnrichment()

  const handleStart = () => startJob.mutate({}, { onSuccess: () => refetch() })
  const handleStop = () => stopJob.mutate(undefined, { onSuccess: () => refetch() })

  return (
    <div className="p-6 md:p-8 md:pt-10 space-y-8 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Data Enrichment</h1>
          <p className="text-muted-foreground mt-2 text-sm md:text-base">Overlay threat intelligence and cloud provider data.</p>
        </div>
        <div className="flex items-center gap-3">
          {status?.isActive ? (
            <Button variant="destructive" onClick={handleStop} disabled={stopJob.isPending} className="font-mono">
              <Square className="w-4 h-4 mr-2" /> stop_enrichment
            </Button>
          ) : (
            <Button onClick={handleStart} disabled={startJob.isPending} className="font-mono">
              <Play className="w-4 h-4 mr-2" /> start_enrichment
            </Button>
          )}
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border-border/60 shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Cloud Ranges</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-semibold font-mono text-foreground flex items-center gap-3">
                <Cloud className="w-6 h-6 text-primary" />
                {stats.totalCloudRanges.toLocaleString()}
              </div>
            </CardContent>
          </Card>
          <Card className="border-border/60 shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Threat Ranges</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-semibold font-mono text-foreground flex items-center gap-3">
                <Shield className="w-6 h-6 text-destructive" />
                {stats.totalThreatRanges.toLocaleString()}
              </div>
            </CardContent>
          </Card>
          <Card className="border-border/60 shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Named ASNs</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-semibold font-mono">{stats.asnNamedCount.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground mt-1 font-mono">/ {stats.asnTotalCount.toLocaleString()} total</div>
            </CardContent>
          </Card>
        </div>
      )}

      {status?.isActive && (
        <Card className="border-primary/40 bg-primary/[0.04] shadow-none ring-1 ring-primary/20">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary animate-pulse" />
              <CardTitle className="text-base font-medium">Active Enrichment Job</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-8">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="space-y-1">
                <span className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Ingested</span>
                <div className="text-2xl font-mono text-primary">{status.job?.totalIngested.toLocaleString() || 0}</div>
              </div>
              <div className="space-y-1">
                <span className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Status</span>
                <div><Badge className="bg-primary/15 text-primary hover:bg-primary/20 uppercase">{status.job?.status}</Badge></div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {status.sources.map(source => (
                <div key={source.sourceId} className="space-y-3 p-4 bg-background/50 border border-border/60 rounded-lg">
                  <div className="flex justify-between text-sm items-center">
                    <span className="font-semibold font-mono tracking-tight">{source.sourceId}</span>
                    <Badge variant="outline" className="uppercase text-[10px] bg-background">{source.status}</Badge>
                  </div>
                  <Progress value={source.status === 'completed' ? 100 : source.status === 'downloading' || source.status === 'parsing' ? 50 : 0} className="h-1.5 bg-primary/10" />
                  <div className="text-xs font-mono text-muted-foreground flex justify-between">
                    <span className="uppercase text-primary/80">{source.kind}</span>
                    <span>{source.recordsIngested.toLocaleString()} rec</span>
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
              {jobs?.map(job => (
                <TableRow key={job.id} className="border-border/60">
                  <TableCell className="font-mono text-xs text-muted-foreground">{job.id.substring(0, 8)}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(job.status)} className="uppercase text-[10px]">
                      {job.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">{format(new Date(job.startedAt), "MMM d, HH:mm:ss")}</TableCell>
                  <TableCell className="font-mono text-sm">{job.durationMs ? `${(job.durationMs / 1000).toFixed(1)}s` : '-'}</TableCell>
                  <TableCell className="text-right font-mono text-primary">{job.totalIngested.toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {!jobs?.length && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">No jobs found in history.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
