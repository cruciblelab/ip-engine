import {
  useListResumableCollectionJobs,
  getListResumableCollectionJobsQueryKey,
  useResumeCollection,
  useListResumableEnrichmentJobs,
  getListResumableEnrichmentJobsQueryKey,
  useResumeEnrichment,
  type ResumableJob,
} from "@workspace/api-client"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { PlayCircle, History, RotateCcw, Database, Network } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { toast } from "@/hooks/use-toast"

function JobGroup({
  title,
  icon: Icon,
  jobs,
  isLoading,
  onResume,
  resuming,
}: {
  title: string
  icon: typeof Database
  jobs: ResumableJob[] | undefined
  isLoading: boolean
  onResume: (jobId?: string) => void
  resuming: boolean
}) {
  return (
    <Card className="border-border/60 shadow-none">
      <CardHeader className="pb-4 border-b border-border/60 bg-muted/20">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className="w-5 h-5 text-primary" />
            <CardTitle className="text-base font-medium">{title}</CardTitle>
          </div>
          {!!jobs?.length && (
            <Button
              size="sm"
              variant="outline"
              className="border-primary/30 hover:bg-primary/10 hover:text-primary font-mono text-xs"
              onClick={() => onResume(undefined)}
              disabled={resuming || !jobs.some((j) => !j.stale)}
            >
              <PlayCircle className="w-3.5 h-3.5 mr-1.5" /> resume latest
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ) : !jobs?.length ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No interrupted jobs — nothing to resume.
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {jobs.map((job) => (
              <li key={job.id} className="px-6 py-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium text-foreground">{job.displayId}</span>
                    {job.stale && (
                      <Badge variant="outline" className="text-[10px] uppercase text-muted-foreground">
                        stale
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    started {formatDistanceToNow(new Date(job.startedAt))} ago · {job.sourcesCompleted}/{job.sourcesTotal} sources done
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  className="shrink-0 font-mono text-xs"
                  onClick={() => onResume(job.id)}
                  disabled={resuming}
                >
                  <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> resume
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

export default function Jobs() {
  const {
    data: collectionJobs,
    isLoading: collectionLoading,
    refetch: refetchCollection,
  } = useListResumableCollectionJobs({
    query: { queryKey: getListResumableCollectionJobsQueryKey(), refetchInterval: 15000 },
  })
  const {
    data: enrichmentJobs,
    isLoading: enrichmentLoading,
    refetch: refetchEnrichment,
  } = useListResumableEnrichmentJobs({
    query: { queryKey: getListResumableEnrichmentJobsQueryKey(), refetchInterval: 15000 },
  })

  const resumeCollection = useResumeCollection()
  const resumeEnrichment = useResumeEnrichment()

  const handleResumeCollection = (jobId?: string) => {
    resumeCollection.mutate(
      { data: jobId ? { jobId } : {} },
      {
        onSuccess: (job) => {
          toast({ title: "Collection resumed", description: `Job ${job.id.slice(0, 8)} is running again.` })
          refetchCollection()
        },
        onError: (err) => {
          toast({ title: "Resume failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" })
        },
      },
    )
  }

  const handleResumeEnrichment = (jobId?: string) => {
    resumeEnrichment.mutate(
      { data: jobId ? { jobId } : {} },
      {
        onSuccess: (job) => {
          toast({ title: "Enrichment resumed", description: `Job ${job.id.slice(0, 8)} is running again.` })
          refetchEnrichment()
        },
        onError: (err) => {
          toast({ title: "Resume failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" })
        },
      },
    )
  }

  return (
    <div className="p-6 md:p-8 md:pt-10 space-y-8 max-w-5xl mx-auto">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight flex items-center gap-3">
          <History className="w-7 h-7 text-primary" /> Interrupted Jobs
        </h1>
        <p className="text-muted-foreground mt-2 text-sm md:text-base">
          A collect/enrich run that was killed mid-way (crash, <span className="font-mono">kill -9</span>, power loss) shows up
          here instead of vanishing — resume it and only the sources that never finished re-run.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <JobGroup
          title="Collection"
          icon={Database}
          jobs={collectionJobs}
          isLoading={collectionLoading}
          onResume={handleResumeCollection}
          resuming={resumeCollection.isPending}
        />
        <JobGroup
          title="Enrichment"
          icon={Network}
          jobs={enrichmentJobs}
          isLoading={enrichmentLoading}
          onResume={handleResumeEnrichment}
          resuming={resumeEnrichment.isPending}
        />
      </div>

      <Card className="border-dashed border-border/60 shadow-none bg-transparent">
        <CardContent className="py-5 text-sm text-muted-foreground">
          <CardDescription className="text-xs uppercase tracking-wider font-semibold mb-1.5">Note</CardDescription>
          Checkpoint tracking is controlled by <span className="font-mono text-foreground">checkpointingEnabled</span> in{" "}
          <span className="font-mono text-foreground">ip-insight.config.json</span> — see the Settings page for the
          effective values (<span className="font-mono text-foreground">checkpointStaleAfterHours</span> hides very old
          jobs from "resume latest" until you pick them explicitly).
        </CardContent>
      </Card>
    </div>
  )
}
