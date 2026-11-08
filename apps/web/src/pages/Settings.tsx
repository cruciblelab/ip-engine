import { useGetSettings, getGetSettingsQueryKey } from "@workspace/api-client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { SlidersHorizontal, CheckCircle2, XCircle } from "lucide-react"

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-6 py-3.5 flex items-center justify-between gap-4 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono text-right">{children}</dd>
    </div>
  )
}

function BoolBadge({ value }: { value: boolean }) {
  return value ? (
    <Badge className="bg-primary/15 text-primary hover:bg-primary/20 gap-1">
      <CheckCircle2 className="w-3 h-3" /> on
    </Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground gap-1">
      <XCircle className="w-3 h-3" /> off
    </Badge>
  )
}

function ListValue({ value }: { value: string[] | null }) {
  if (!value) return <span className="text-primary">all</span>
  return (
    <div className="flex flex-wrap gap-1 justify-end">
      {value.map((v) => (
        <Badge key={v} variant="outline" className="text-[10px] font-mono">
          {v}
        </Badge>
      ))}
    </div>
  )
}

export default function Settings() {
  const { data: settings, isLoading } = useGetSettings({
    query: { queryKey: getGetSettingsQueryKey() },
  })

  if (isLoading || !settings) {
    return (
      <div className="p-6 md:p-8 md:pt-10 space-y-6 max-w-4xl mx-auto">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-48 w-full rounded-xl" />
        ))}
      </div>
    )
  }

  return (
    <div className="p-6 md:p-8 md:pt-10 space-y-8 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight flex items-center gap-3">
          <SlidersHorizontal className="w-7 h-7 text-primary" /> Settings
        </h1>
        <p className="text-muted-foreground mt-2 text-sm md:text-base">
          Effective <span className="font-mono">ip-insight.config.json</span> values — read-only here. Edit the file
          {settings.sourcePath ? (
            <> at <span className="font-mono text-foreground">{settings.sourcePath}</span></>
          ) : (
            " (none found — every value below is a default)"
          )}{" "}
          and rerun/restart to change it.
        </p>
      </div>

      <Card className="border-border/60 shadow-none">
        <CardHeader className="pb-3 border-b border-border/60 bg-muted/20">
          <CardTitle className="text-base font-medium">Collection & Enrichment</CardTitle>
        </CardHeader>
        <CardContent className="p-0 divide-y divide-border/60">
          <Row label="collection sources"><ListValue value={settings.collection} /></Row>
          <Row label="collectionStatuses"><ListValue value={settings.collectionStatuses} /></Row>
          <Row label="enrichment sources"><ListValue value={settings.enrichment} /></Row>
          <Row label="batchSize">{settings.batchSize.toLocaleString()}</Row>
          <Row label="fetchRetry">
            {settings.fetchRetryMaxAttempts} attempts · {settings.fetchRetryBaseDelayMs}ms base · {settings.fetchRetryTimeoutMs}ms timeout
          </Row>
          <Row label="exportFormat / exportDir">
            {settings.exportFormat} · {settings.exportDir}
          </Row>
          <Row label="summaryDir">{settings.summaryDir}</Row>
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-none">
        <CardHeader className="pb-3 border-b border-border/60 bg-muted/20">
          <CardTitle className="text-base font-medium">Checkpoint / Resume</CardTitle>
        </CardHeader>
        <CardContent className="p-0 divide-y divide-border/60">
          <Row label="checkpointingEnabled"><BoolBadge value={settings.checkpointingEnabled} /></Row>
          <Row label="checkpointIdFormat">{settings.checkpointIdFormat}</Row>
          <Row label="checkpointStaleAfterHours">{settings.checkpointStaleAfterHours}h</Row>
          <Row label="checkpointAutoCleanupStaleJobs"><BoolBadge value={settings.checkpointAutoCleanupStaleJobs} /></Row>
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-none">
        <CardHeader className="pb-3 border-b border-border/60 bg-muted/20">
          <CardTitle className="text-base font-medium">Background Automation</CardTitle>
        </CardHeader>
        <CardContent className="p-0 divide-y divide-border/60">
          <Row label="maintenanceSchedulerEnabled"><BoolBadge value={settings.maintenanceSchedulerEnabled} /></Row>
          <Row label="backupEnabled"><BoolBadge value={settings.backupEnabled} /></Row>
          <Row label="backupIntervalHours / retention">
            {settings.backupIntervalHours}h · keep {settings.backupRetentionCount}
          </Row>
          <Row label="backupDir">{settings.backupDir}</Row>
          <Row label="sleepModeEnabled"><BoolBadge value={settings.sleepModeEnabled} /></Row>
          <Row label="sleepModeIdleHours">{settings.sleepModeIdleHours}h</Row>
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-none">
        <CardHeader className="pb-3 border-b border-border/60 bg-muted/20">
          <CardTitle className="text-base font-medium">Lookup</CardTitle>
        </CardHeader>
        <CardContent className="p-0 divide-y divide-border/60">
          <Row label="lookupFeatures"><ListValue value={settings.lookupFeatures} /></Row>
          <Row label="cacheSize / cacheTtlMinutes">
            {settings.cacheSize.toLocaleString()} · {settings.cacheTtlMinutes}m
          </Row>
          <Row label="reverseDnsTimeoutMs">{settings.reverseDnsTimeoutMs}ms</Row>
          <Row label="bulkLookupConcurrency">{settings.bulkLookupConcurrency}</Row>
        </CardContent>
      </Card>
    </div>
  )
}
