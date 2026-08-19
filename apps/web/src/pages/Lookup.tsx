import { useState } from "react"
import {
  useLookupIp,
  getLookupIpQueryKey,
  useLookupAsn,
  getLookupAsnQueryKey,
  useLookupBulkIps,
} from "@workspace/api-client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Search, Globe, Network, ShieldAlert, Zap, Server, AlignJustify, Gauge, RadioTower } from "lucide-react"
import type { IpLookupResult } from "@workspace/api-client"

// `found` only reflects whether a base RIR allocation row matched — the
// layered model can still resolve real ASN/geo/special-purpose data with no
// such row (e.g. a documentation/test range, or a prefix collected via BGP
// before its RIR file caught up). Treat "nothing at all" as the true empty
// case instead, matching the CLI's same distinction (see apps/cli's
// commands/lookup.ts).
function hasAnyIpData(data: IpLookupResult): boolean {
  return !!(data.network.cidr || data.asn.number || data.geo.country || data.special_purpose)
}

export default function Lookup() {
  const [query, setQuery] = useState("")
  const [activeQuery, setActiveQuery] = useState("")
  const [isAsn, setIsAsn] = useState(false)
  const [bulkQuery, setBulkQuery] = useState("")
  
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return
    
    let normalized = query.trim().toUpperCase()
    if (normalized.startsWith("AS")) {
      setIsAsn(true)
      setActiveQuery(normalized.replace("AS", ""))
    } else if (/^\d+$/.test(normalized)) {
      setIsAsn(true)
      setActiveQuery(normalized)
    } else {
      setIsAsn(false)
      setActiveQuery(normalized.toLowerCase())
    }
  }

  const { data: ipData, isLoading: ipLoading } = useLookupIp(activeQuery, {
    query: { queryKey: getLookupIpQueryKey(activeQuery), enabled: !isAsn && !!activeQuery },
  })
  const { data: asnData, isLoading: asnLoading } = useLookupAsn(activeQuery, {
    query: { queryKey: getLookupAsnQueryKey(activeQuery), enabled: isAsn && !!activeQuery },
  })
  
  const bulkLookup = useLookupBulkIps()

  const handleBulkSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (!bulkQuery.trim()) return
    
    const ips = bulkQuery.split(/[\n,;\s]+/).map(ip => ip.trim()).filter(Boolean)
    if (ips.length > 0) {
      bulkLookup.mutate({ data: { ips } })
    }
  }

  const isLoading = ipLoading || asnLoading

  return (
    <div className="p-6 md:p-8 md:pt-16 space-y-8 max-w-4xl mx-auto">
      <div className="text-center space-y-4 mb-12">
        <h1 className="text-4xl font-bold tracking-tight">Intelligence Lookup</h1>
        <p className="text-muted-foreground text-sm md:text-base">Query IP addresses or ASNs for complete registry and enrichment data.</p>
        
        <Tabs defaultValue="single" className="max-w-2xl mx-auto mt-8">
          <TabsList className="mb-4">
            <TabsTrigger value="single">Single Target</TabsTrigger>
            <TabsTrigger value="bulk">Bulk Upload</TabsTrigger>
          </TabsList>
          
          <TabsContent value="single">
            <form onSubmit={handleSearch} className="flex gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground w-5 h-5" />
                <Input 
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="e.g. 1.1.1.1, 2001:4860:4860::8888, AS13335" 
                  className="pl-12 h-14 text-lg font-mono bg-card border-primary/30 focus-visible:ring-primary/50 shadow-sm"
                />
              </div>
              <Button type="submit" size="lg" className="h-14 px-8 font-bold tracking-widest text-sm uppercase">Lookup</Button>
            </form>
          </TabsContent>
          
          <TabsContent value="bulk">
            <form onSubmit={handleBulkSearch} className="space-y-3 text-left">
              <Textarea 
                value={bulkQuery}
                onChange={(e) => setBulkQuery(e.target.value)}
                placeholder="Paste up to 1000 IP addresses, one per line or comma-separated." 
                className="min-h-[160px] font-mono text-sm bg-card border-primary/30"
              />
              <Button type="submit" size="lg" className="w-full font-bold tracking-widest uppercase" disabled={bulkLookup.isPending}>
                <AlignJustify className="w-4 h-4 mr-2" /> Bulk Process
              </Button>
            </form>
          </TabsContent>
        </Tabs>
      </div>

      {isLoading && (
        <div className="space-y-6 animate-pulse mt-12">
          <div className="h-40 bg-card border border-border/60 rounded-lg"></div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
             <div className="h-64 bg-card border border-border/60 rounded-lg"></div>
             <div className="h-64 bg-card border border-border/60 rounded-lg"></div>
          </div>
        </div>
      )}

      {/* RENDER SINGLE IP RESULT */}
      {!isAsn && ipData && hasAnyIpData(ipData) && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
          {!ipData.found && (
            <p className="text-xs text-muted-foreground text-center">
              No base RIR allocation row — resolved from other layers below.
            </p>
          )}
          <Card className="border-primary/30 bg-card/50 shadow-none backdrop-blur">
            <CardContent className="p-6 md:p-8 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
              <div>
                <div className="text-xs text-muted-foreground font-semibold uppercase tracking-widest mb-2">Target IP</div>
                <div className="text-3xl md:text-4xl font-mono font-bold text-primary tracking-tight">{ipData.ip}</div>
              </div>
              <div className="flex flex-wrap gap-2 justify-end">
                {ipData.cached && <Badge variant="outline" className="border-primary/50 text-primary font-mono"><Zap className="w-3 h-3 mr-1" /> {ipData.latencyMs}ms</Badge>}
                <Badge variant="secondary" className="font-mono bg-secondary/80">IPv{ipData.family}</Badge>
                {ipData.anycast && <Badge variant="secondary" className="bg-secondary/80">Anycast</Badge>}
                {ipData.cloud_provider && <Badge className="bg-[hsl(var(--chart-3))] text-[hsl(var(--background))] font-semibold uppercase"><Server className="w-3 h-3 mr-1" /> {ipData.cloud_provider}</Badge>}
                {ipData.threat.is_malicious && <Badge variant="destructive" className="font-semibold uppercase"><ShieldAlert className="w-3 h-3 mr-1" /> Malicious</Badge>}
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="border-border/60 shadow-none">
              <CardHeader className="pb-4 border-b border-border/60 bg-muted/20">
                <div className="flex items-center gap-2">
                  <Network className="w-5 h-5 text-primary" />
                  <CardTitle className="text-base font-medium">Network & ASN</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <dl className="divide-y divide-border/60 text-sm">
                  <div className="px-6 py-4 flex justify-between">
                    <dt className="text-muted-foreground">CIDR Route</dt>
                    <dd className="font-mono font-medium text-primary">{ipData.network.cidr || "-"}</dd>
                  </div>
                  <div className="px-6 py-4 flex justify-between">
                    <dt className="text-muted-foreground">Network Name</dt>
                    <dd className="font-medium text-right max-w-[200px] truncate" title={ipData.network.network_name || "-"}>{ipData.network.network_name || "-"}</dd>
                  </div>
                  <div className="px-6 py-4 flex justify-between items-center">
                    <dt className="text-muted-foreground">RIR Status</dt>
                    <dd>
                      {ipData.network.status ? (
                        <Badge variant="outline" className="uppercase text-[10px] font-mono">{ipData.network.status}</Badge>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </dd>
                  </div>
                  <div className="px-6 py-4 flex justify-between">
                    <dt className="text-muted-foreground">ASN</dt>
                    <dd className="font-mono font-semibold text-foreground">{ipData.asn.number ? `AS${ipData.asn.number}` : "-"}</dd>
                  </div>
                  <div className="px-6 py-4 flex justify-between">
                    <dt className="text-muted-foreground">ASN Name</dt>
                    <dd className="font-medium text-right max-w-[200px] truncate" title={ipData.asn.name || "-"}>{ipData.asn.name || "-"}</dd>
                  </div>
                  <div className="px-6 py-4 flex justify-between">
                    <dt className="text-muted-foreground">Provider Type</dt>
                    <dd className="font-medium capitalize">{ipData.asn.type || "-"}</dd>
                  </div>
                  <div className="px-6 py-4 flex justify-between">
                    <dt className="text-muted-foreground" title="Rank by announced IPv4 address space — a size measure, not an importance measure">
                      Size Rank
                    </dt>
                    <dd className="font-mono">
                      {ipData.asn.rank ? (
                        <>
                          <span className="font-semibold text-primary">#{ipData.asn.rank}</span>
                          {ipData.asn.originated_prefixes != null && (
                            <span className="text-muted-foreground text-xs ml-2">
                              {ipData.asn.originated_prefixes.toLocaleString()} prefixes
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </dd>
                  </div>
                  {ipData.asn.originated_addresses != null && (
                    <div className="px-6 py-4 flex justify-between">
                      <dt className="text-muted-foreground">Announced Space</dt>
                      <dd className="font-mono">
                        {ipData.asn.originated_addresses.toLocaleString()}
                        <span className="text-muted-foreground text-xs ml-1">IPv4</span>
                        {ipData.asn.peer_visibility != null && (
                          <span className="text-muted-foreground text-xs ml-2">
                            · seen by {ipData.asn.peer_visibility} collectors
                          </span>
                        )}
                      </dd>
                    </div>
                  )}
                  <div className="px-6 py-4 flex justify-between">
                    <dt className="text-muted-foreground">Registry</dt>
                    <dd className="font-semibold uppercase tracking-wider">{ipData.network.rir || "-"}</dd>
                  </div>
                  {ipData.special_purpose && (
                    <div className="px-6 py-4 flex justify-between bg-primary/[0.04]">
                      <dt className="font-medium">Special-Purpose</dt>
                      <dd className="font-semibold text-right max-w-[220px]">
                        {ipData.special_purpose.name}
                        {ipData.special_purpose.rfc && (
                          <span className="block text-xs font-normal text-muted-foreground">{ipData.special_purpose.rfc}</span>
                        )}
                      </dd>
                    </div>
                  )}
                </dl>
              </CardContent>
            </Card>

            <Card className="border-border/60 shadow-none">
              <CardHeader className="pb-4 border-b border-border/60 bg-muted/20">
                <div className="flex items-center gap-2">
                  <Globe className="w-5 h-5 text-primary" />
                  <CardTitle className="text-base font-medium">Geolocation & Usage</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <dl className="divide-y divide-border/60 text-sm">
                  <div className="px-6 py-4 flex justify-between">
                    <dt className="text-muted-foreground">Country</dt>
                    <dd className="font-medium uppercase tracking-wider">{ipData.geo.country || "-"}</dd>
                  </div>
                  <div className="px-6 py-4 flex justify-between">
                    <dt className="text-muted-foreground">Location</dt>
                    <dd className="font-medium">{[ipData.geo.region, ipData.geo.city].filter(Boolean).join(" / ") || "-"}</dd>
                  </div>
                  <div className="px-6 py-4 flex justify-between items-center">
                    <dt className="text-muted-foreground">Geo Source</dt>
                    <dd>
                      {ipData.geo.geo_source ? (
                        <Badge
                          variant="outline"
                          className={`uppercase text-[10px] font-mono ${ipData.geo.geo_source === "geofeed" ? "border-primary/50 text-primary" : ""}`}
                        >
                          {ipData.geo.geo_source}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </dd>
                  </div>
                  <div className="px-6 py-4 flex justify-between">
                    <dt className="text-muted-foreground">Primary Usage</dt>
                    <dd className="font-medium capitalize">{ipData.usage_type || "-"}</dd>
                  </div>
                  <div className="px-6 py-4 flex justify-between">
                    <dt className="text-muted-foreground">Flags</dt>
                    <dd className="font-medium flex gap-1.5 flex-wrap justify-end">
                      {ipData.flags.length > 0 ? ipData.flags.map(f => <Badge key={f} variant="outline" className="text-[10px] uppercase font-mono py-0">{f}</Badge>) : "-"}
                    </dd>
                  </div>
                  {ipData.threat.is_malicious && (
                    <div className="px-6 py-4 flex justify-between bg-destructive/10 text-destructive border-t-destructive/20">
                      <dt className="font-semibold flex items-center"><ShieldAlert className="w-4 h-4 mr-2" /> Threat Source</dt>
                      <dd className="font-semibold text-right max-w-[200px] truncate">{ipData.threat.sources.join(", ")}</dd>
                    </div>
                  )}
                  {(ipData.anonymity.is_tor || ipData.anonymity.is_vpn || ipData.anonymity.is_proxy) && (
                    <div className="px-6 py-4 flex justify-between">
                      <dt className="text-muted-foreground">Anonymity</dt>
                      <dd className="font-medium flex gap-1.5 flex-wrap justify-end">
                        {ipData.anonymity.is_tor && <Badge variant="outline" className="text-[10px] uppercase font-mono py-0">tor exit</Badge>}
                        {ipData.anonymity.is_vpn && <Badge variant="outline" className="text-[10px] uppercase font-mono py-0">vpn egress</Badge>}
                        {ipData.anonymity.is_proxy && <Badge variant="outline" className="text-[10px] uppercase font-mono py-0">proxy</Badge>}
                        {ipData.anonymity.providers.map(p => <Badge key={p} variant="secondary" className="text-[10px] font-mono py-0">{p}</Badge>)}
                      </dd>
                    </div>
                  )}
                  {ipData.rpki.status && (
                    <div className="px-6 py-4 flex justify-between">
                      <dt className="text-muted-foreground" title="Is the observed BGP origin the one the prefix holder cryptographically authorised?">RPKI</dt>
                      <dd className="font-mono">
                        <span className={
                          ipData.rpki.status === "invalid" ? "text-destructive font-semibold"
                          : ipData.rpki.status === "valid" ? "text-primary font-semibold"
                          : "text-muted-foreground"
                        }>{ipData.rpki.status}</span>
                        {ipData.rpki.authorized_asns.length > 0 && (
                          <span className="text-muted-foreground text-xs ml-2">
                            AS{ipData.rpki.authorized_asns.join(", AS")}
                          </span>
                        )}
                      </dd>
                    </div>
                  )}
                  {ipData.connection_type && (
                    <div className="px-6 py-4 flex justify-between">
                      <dt className="text-muted-foreground" title="Heuristic guess from ASN name / rDNS text — never authoritative">Connection Type</dt>
                      <dd className="font-medium capitalize">
                        {ipData.connection_type.type}
                        <span className="text-muted-foreground text-xs ml-2 font-mono">heuristic</span>
                      </dd>
                    </div>
                  )}
                  {ipData.abuse?.email && (
                    <div className="px-6 py-4 flex justify-between">
                      <dt className="text-muted-foreground">Abuse Contact</dt>
                      <dd className="font-mono text-xs text-right max-w-[220px] truncate">{ipData.abuse.email}</dd>
                    </div>
                  )}
                  {ipData.risk && (
                    <div className="px-6 py-4 flex justify-between">
                      <dt className="text-muted-foreground" title="Transparent composite of the signals above — not a calibrated fraud probability">Risk</dt>
                      <dd className="text-right">
                        <span className={
                          ipData.risk.level === "high" ? "text-destructive font-semibold font-mono"
                          : ipData.risk.level === "medium" ? "text-primary font-semibold font-mono"
                          : "text-muted-foreground font-mono"
                        }>{ipData.risk.score}/100 {ipData.risk.level}</span>
                        {ipData.risk.reasons.length > 0 && (
                          <div className="text-muted-foreground text-[10px] font-mono mt-1">{ipData.risk.reasons.join(", ")}</div>
                        )}
                      </dd>
                    </div>
                  )}
                </dl>
              </CardContent>
            </Card>
          </div>

          <Card className="border-border/60 shadow-none">
            <CardHeader className="pb-4 border-b border-border/60 bg-muted/20">
              <div className="flex items-center gap-2">
                <Gauge className="w-5 h-5 text-primary" />
                <CardTitle className="text-base font-medium">Confidence & Signals</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="p-6 space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                {([
                  ["Overall", ipData.confidence.overall],
                  ["Network", ipData.confidence.network],
                  ["Geo", ipData.confidence.geo],
                  ["ASN", ipData.confidence.asn],
                  ["Threat", ipData.confidence.threat],
                ] as const).map(([label, value]) => (
                  <div key={label} className="space-y-1.5">
                    <div className="flex justify-between text-xs text-muted-foreground uppercase tracking-wider">
                      <span>{label}</span>
                      <span className="font-mono">{value !== null && value !== undefined ? value.toFixed(2) : "-"}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all"
                        style={{ width: `${((value ?? 0) * 100).toFixed(0)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              {ipData.reverse_dns && (
                <div className="flex items-center gap-2 text-sm pt-2 border-t border-border/60 mt-4">
                  <RadioTower className="w-4 h-4 text-muted-foreground" />
                  <span className="text-muted-foreground">rDNS</span>
                  <span className="font-mono text-foreground">{ipData.reverse_dns}</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* RENDER ASN RESULT */}
      {isAsn && asnData && asnData.found && (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <Card className="border-primary/30 shadow-none">
            <CardHeader className="pb-4 border-b border-border/60 bg-muted/20">
              <div className="text-xs text-muted-foreground font-semibold uppercase tracking-widest mb-1">Autonomous System</div>
              <div className="text-4xl font-mono font-bold text-primary tracking-tight">AS{asnData.asn}</div>
            </CardHeader>
            <CardContent className="p-0">
              <dl className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 text-sm">
                  <div className="px-6 py-5 flex justify-between md:border-b md:border-r border-border/60">
                    <dt className="text-muted-foreground">Holder Name</dt>
                    <dd className="font-bold text-right text-base">{asnData.name || "-"}</dd>
                  </div>
                  <div className="px-6 py-5 flex justify-between md:border-b border-border/60">
                    <dt className="text-muted-foreground">Provider Type</dt>
                    <dd className="font-medium capitalize text-base">{asnData.type || "-"}</dd>
                  </div>
                  <div className="px-6 py-5 flex justify-between md:border-r border-border/60">
                    <dt className="text-muted-foreground">Country</dt>
                    <dd className="font-medium uppercase tracking-wider text-base">{asnData.country || "-"}</dd>
                  </div>
                  <div className="px-6 py-5 flex justify-between border-border/60">
                    <dt className="text-muted-foreground">Registry</dt>
                    <dd className="font-medium uppercase tracking-wider text-base">{asnData.rir || "-"}</dd>
                  </div>
              </dl>
            </CardContent>
          </Card>
        </div>
      )}

      {/* RENDER BULK RESULTS */}
      {bulkLookup.data && (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="flex justify-between items-end">
            <div>
              <h2 className="text-xl font-bold tracking-tight">Bulk Results</h2>
              <p className="text-sm text-muted-foreground">Processed {bulkLookup.data.count} IPs in {bulkLookup.data.latencyMs}ms</p>
            </div>
          </div>
          
          <div className="grid grid-cols-1 gap-3">
            {bulkLookup.data.results.map((res, i) => (
              <Card key={i} className="border-border/60 shadow-none overflow-hidden">
                <div className="flex flex-col md:flex-row divide-y md:divide-y-0 md:divide-x divide-border/60">
                  <div className="p-4 md:w-64 bg-muted/10 shrink-0">
                    <div className="font-mono font-bold text-primary">{res.ip}</div>
                    <div className="text-xs text-muted-foreground mt-1">{hasAnyIpData(res) ? (res.network.network_name || "Unknown Network") : "Not Found"}</div>
                  </div>
                  {hasAnyIpData(res) ? (
                    <div className="p-4 flex-1 flex flex-wrap gap-x-6 gap-y-2 text-sm items-center">
                      <div className="flex items-center gap-1.5 min-w-[120px]">
                        <Globe className="w-4 h-4 text-muted-foreground" />
                        <span>{res.geo.country || "Unk"}</span>
                      </div>
                      <div className="flex items-center gap-1.5 min-w-[120px]">
                        <Network className="w-4 h-4 text-muted-foreground" />
                        <span className="font-mono">AS{res.asn.number || "?"}</span>
                      </div>
                      <div className="flex gap-1 flex-1 justify-end items-center">
                        {res.threat.is_malicious && <Badge variant="destructive" className="h-5 text-[10px] uppercase">Threat</Badge>}
                        {res.cloud_provider && <Badge className="bg-[hsl(var(--chart-3))] text-[hsl(var(--background))] h-5 text-[10px] uppercase">{res.cloud_provider}</Badge>}
                        {res.usage_type && <Badge variant="secondary" className="h-5 text-[10px] uppercase">{res.usage_type}</Badge>}
                      </div>
                    </div>
                  ) : (
                    <div className="p-4 flex-1 flex items-center text-sm text-muted-foreground italic">
                      No data available
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {((!isAsn && ipData && !hasAnyIpData(ipData)) || (isAsn && asnData && !asnData.found)) && (
        <Card className="border-dashed border-2 bg-transparent text-center py-16 animate-in fade-in">
          <CardContent>
            <div className="text-2xl font-bold text-muted-foreground">RECORD_NOT_FOUND</div>
            <p className="text-sm mt-3 text-muted-foreground/70 font-mono">The requested identifier was not located in the local registry.</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
