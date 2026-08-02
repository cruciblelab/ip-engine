import { useState } from "react"
import { useGetCronSchedules, useUpdateCronSchedule, useTriggerCronJob } from "@workspace/api-client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { format } from "date-fns"
import { toast } from "@/hooks/use-toast"
import { Play } from "lucide-react"

const PRESETS = [
  { label: "Daily 2am", value: "0 2 * * *" },
  { label: "Weekly Sun 2am", value: "0 2 * * 0" },
  { label: "Twice Daily", value: "0 2,14 * * *" },
  { label: "Every 6h", value: "0 */6 * * *" },
]

export default function Scheduler() {
  const { data: schedules, refetch } = useGetCronSchedules()
  
  return (
    <div className="p-6 md:p-8 md:pt-10 space-y-8 max-w-5xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Cron Scheduler</h1>
        <p className="text-muted-foreground mt-2 text-sm md:text-base">Automate data collection and enrichment routines.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {schedules?.map(sched => (
          <ScheduleCard key={sched.name} schedule={sched} onUpdated={() => refetch()} />
        ))}
      </div>
    </div>
  )
}

function ScheduleCard({ schedule, onUpdated }: { schedule: any, onUpdated: () => void }) {
  const [expr, setExpr] = useState(schedule.expression || "")
  const [enabled, setEnabled] = useState(schedule.enabled)
  const updateSched = useUpdateCronSchedule()
  const triggerJob = useTriggerCronJob()

  const handleSave = () => {
    updateSched.mutate({ name: schedule.name, data: { expression: enabled ? expr : null } }, {
      onSuccess: () => {
        toast({ title: "Schedule updated", description: `Saved configuration for ${schedule.name}` })
        onUpdated()
      }
    })
  }

  const handleTrigger = () => {
    triggerJob.mutate({ name: schedule.name }, {
      onSuccess: () => {
        toast({ title: "Job triggered", description: `Started ${schedule.name} manually.` })
      }
    })
  }

  return (
    <Card className={`border-border/60 shadow-none transition-colors ${enabled ? 'ring-1 ring-primary/20' : ''}`}>
      <CardHeader className="flex flex-row items-center justify-between pb-4 border-b border-border/60 bg-muted/20">
        <div>
          <CardTitle className="capitalize text-lg">{schedule.name} Job</CardTitle>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs uppercase font-semibold tracking-wider text-muted-foreground">{enabled ? 'Active' : 'Disabled'}</span>
          <Switch 
            checked={enabled} 
            onCheckedChange={(c) => {
              setEnabled(c)
              updateSched.mutate({ name: schedule.name, data: { expression: c ? expr : null } }, { onSuccess: onUpdated })
            }} 
          />
        </div>
      </CardHeader>
      <CardContent className="pt-6 space-y-6">
        <div className="space-y-4">
          <label className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Cron Expression</label>
          <div className="flex gap-2">
            <Input 
              value={expr} 
              onChange={e => setExpr(e.target.value)} 
              className="font-mono text-base h-11 bg-background" 
              placeholder="0 2 * * *"
              disabled={!enabled}
            />
            <Button onClick={handleSave} disabled={!enabled || updateSched.isPending} className="h-11 px-6 font-semibold">SAVE</Button>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {PRESETS.map(p => (
              <Badge 
                key={p.value} 
                variant="outline" 
                className={`cursor-pointer hover:bg-primary/20 transition-colors text-[11px] font-mono ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}
                onClick={() => { if(enabled) { setExpr(p.value) } }}
              >
                {p.label}
              </Badge>
            ))}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-6 text-sm bg-muted/30 p-5 rounded-lg border border-border/60">
          <div>
            <dt className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-1">Last Run</dt>
            <dd className="font-mono">{schedule.lastRunAt ? format(new Date(schedule.lastRunAt), "MMM d, HH:mm") : "Never"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-1">Next Run</dt>
            <dd className="font-mono font-medium text-primary">{schedule.nextRunAt ? format(new Date(schedule.nextRunAt), "MMM d, HH:mm") : "-"}</dd>
          </div>
          <div className="col-span-2 pt-2 border-t border-border/60 mt-2 flex justify-between items-center">
            <div>
              <dt className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-1">Last Status</dt>
              <dd>
                <Badge variant={schedule.lastRunStatus === 'success' ? 'default' : schedule.lastRunStatus === 'error' ? 'destructive' : 'secondary'} className="uppercase text-[10px]">
                  {schedule.lastRunStatus || 'Unknown'}
                </Badge>
              </dd>
            </div>
            <Button variant="outline" size="sm" onClick={handleTrigger} disabled={triggerJob.isPending} className="font-mono text-xs mt-2 border-primary/30 hover:bg-primary/10 hover:text-primary">
              <Play className="w-3 h-3 mr-2" /> TRIGGER
            </Button>
          </div>
        </dl>
      </CardContent>
    </Card>
  )
}
