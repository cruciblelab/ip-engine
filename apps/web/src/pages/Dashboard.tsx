import {
  useGetDatabaseOverview,
  getGetDatabaseOverviewQueryKey,
  useGetRegistrationTimeline,
  getGetRegistrationTimelineQueryKey,
  useGetRirDistribution,
  getGetRirDistributionQueryKey,
} from "@workspace/api-client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { format } from "date-fns"
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend } from "recharts"

export default function Dashboard() {
  const { data: overview, isLoading: overviewLoading } = useGetDatabaseOverview({
    query: { queryKey: getGetDatabaseOverviewQueryKey(), refetchInterval: 10000 },
  })
  const { data: timeline } = useGetRegistrationTimeline({
    query: { queryKey: getGetRegistrationTimelineQueryKey() },
  })
  const { data: rirDist } = useGetRirDistribution({
    query: { queryKey: getGetRirDistributionQueryKey() },
  })

  return (
    <div className="p-6 md:p-8 md:pt-10 space-y-8 max-w-7xl mx-auto">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">System Overview</h1>
        <p className="text-muted-foreground mt-2 text-sm md:text-base">
          Live global internet registry statistics and ingest status.
        </p>
      </div>

      {overviewLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : overview ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard title="Total Blocks" value={overview.totalBlocks.toLocaleString()} highlight />
          <StatCard title="IPv4 Blocks" value={overview.ipv4Blocks.toLocaleString()} />
          <StatCard title="IPv6 Blocks" value={overview.ipv6Blocks.toLocaleString()} />
          <StatCard title="ASN Blocks" value={overview.asnBlocks.toLocaleString()} />
          <StatCard title="Total IPv4 Addr" value={overview.totalIpv4Addresses.toLocaleString()} />
          <StatCard title="Total Countries" value={overview.totalCountries.toLocaleString()} />
          <StatCard title="Total RIRs" value={overview.totalRirs.toLocaleString()} />
          <StatCard
            title="Last Ingest"
            value={overview.lastIngestAt ? format(new Date(overview.lastIngestAt), "MMM d, HH:mm") : "Never"}
            isDate
          />
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="border-border/60 shadow-none">
          <CardHeader className="pb-6">
            <CardTitle className="text-base font-medium">Allocation Timeline</CardTitle>
          </CardHeader>
          <CardContent className="h-80">
            {timeline ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timeline} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="year" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                    tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      borderColor: "hsl(var(--border))",
                      color: "hsl(var(--foreground))",
                      borderRadius: "10px",
                    }}
                  />
                  <Area type="monotone" dataKey="ipv4" stackId="1" stroke="hsl(var(--chart-1))" fill="hsl(var(--chart-1))" fillOpacity={0.2} />
                  <Area type="monotone" dataKey="ipv6" stackId="1" stroke="hsl(var(--chart-2))" fill="hsl(var(--chart-2))" fillOpacity={0.2} />
                  <Area type="monotone" dataKey="asn" stackId="1" stroke="hsl(var(--chart-3))" fill="hsl(var(--chart-3))" fillOpacity={0.2} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: "12px" }} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <Skeleton className="w-full h-full rounded-xl" />
            )}
          </CardContent>
        </Card>

        <Card className="border-border/60 shadow-none">
          <CardHeader className="pb-6">
            <CardTitle className="text-base font-medium">RIR Distribution</CardTitle>
          </CardHeader>
          <CardContent className="h-80">
            {rirDist ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rirDist} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="rir" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                    tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: "hsl(var(--muted) / 0.5)" }}
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      borderColor: "hsl(var(--border))",
                      color: "hsl(var(--foreground))",
                      borderRadius: "10px",
                    }}
                  />
                  <Bar dataKey="ipv4Blocks" stackId="a" fill="hsl(var(--chart-1))" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="ipv6Blocks" stackId="a" fill="hsl(var(--chart-2))" />
                  <Bar dataKey="asnBlocks" stackId="a" fill="hsl(var(--chart-3))" radius={[4, 4, 0, 0]} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: "12px" }} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <Skeleton className="w-full h-full rounded-xl" />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function StatCard({ title, value, isDate = false, highlight = false }: { title: string; value: string; isDate?: boolean; highlight?: boolean }) {
  return (
    <Card className={`border-border/60 shadow-none ${highlight ? "ring-1 ring-primary/25 bg-primary/[0.04]" : ""}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-semibold ${isDate ? "text-foreground" : "font-mono text-primary"}`}>{value}</div>
      </CardContent>
    </Card>
  )
}
