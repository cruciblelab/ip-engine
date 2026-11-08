# mmdb serving throughput, and SaaS cost/capacity economics

Split out of `DEPLOY.md` on 2026-08-07.

---

## .mmdb serving throughput, measured for real on the phone (2026-08-07)

A standalone benchmark harness (`scripts/mmdb-bench/{server.mjs,loadtest.mjs}`,
outside the shipped product — a load-testing tool, not something
`export-mmdb`/`mmdb publish` depend on) was built and run against the real
`current.mmdb` this session's `cycle` produced (2,880,315 prefixes, 63.3 MB,
built via `export-mmdb` earlier this same document).

**Wrong number, caught before it stuck**: the first load-test client used
Node's global `fetch()`. Against the real server, it collapsed past
concurrency=5 (929 → 74 → 256 req/s, latency spiking past a second) —
`undici`'s own connection-pool queuing, not the server's real capacity.
Rewritten on `node:http` with an explicit `Agent` sized to the concurrency
level: same server, same levels, 7,601 → 10,977 → 11,183 req/s. **Any
future load-testing script for this project should use `node:http`/`Agent`
directly, never bare `fetch()`** — verified fact now, not a guess.

**`node:cluster` does not work on this phone (Termux/Android, Node v24)**,
tried three ways, all failed the same way (`bind EADDRINUSE null:<port>`):
default round-robin scheduling (`SCHED_RR`), `SCHED_NONE` (which normally
falls back to `SO_REUSEPORT`), and even giving each worker its own
distinct port — one worker out of eight still hit the identical error
intermittently, pointing at a bug in Node's cluster IPC/handle-registration
on this platform rather than anything reachable from application code.
Resolved by not using `node:cluster` at all: `server.mjs` is single-process
only, and multi-core testing launches N independent OS processes directly
from the shell (`for i in ...; do node server.mjs ... $port & done`) — no
shared Node subsystem, nothing to race.

**A second real gotcha, caught mid-session**: `os.cpus()` returns an empty
array on this phone (Termux can't read `/proc/cpuinfo`) — `nproc` still
works and reported the true count (8). Anything relying on
`os.cpus().length` for a worker/core count on this platform needs a
`nproc`-sourced override; it cannot be trusted on its own here.

**A third gotcha, purely a shell mistake**: `wait` with no arguments waits
for *every* background job in the shell session, including the still-
running (never-exiting) server processes started earlier in the same
terminal — not just the newly-launched benchmark clients. Looked exactly
like a hang. Fixed by collecting each client's PID (`pids+=($!)`) and
calling `wait "${pids[@]}"` instead of bare `wait`.

**The Node-only number, before the real flaw was found**: 8 independent
server processes (one per port, 8199–8206) *and* 8 independent Node
client processes (one per server, so neither side was itself the
bottleneck) run truly in parallel via the shell — ~9,100 req/s aggregate
(per-pair peaks 1,028–1,233 req/s at concurrency=50 each). Superseded
below — kept only because the debugging path to the real number is worth
having on record.

**A second `fetch()`-class mistake, this time about the language, not just
the client library.** The founder recalled a much higher figure ("~40K
req/s, raw mmdb read") from earlier work this project's notes didn't
capture. Suspecting the *client* was still the limiting factor even after
switching to `node:http`/`Agent` — a single Node process is still one
thread — a second server (`bench-go/main.go`, same `/lookup/<ip>` and
`/health` contract, `github.com/oschwald/maxminddb-golang`) and a second
load-test client (`bench-go/loadtest.go`, goroutines instead of Node
workers) were built. First check, sandbox, 4 cores, small test fixture: Go
server + **Node** client → 26,384 req/s; the *same* Go server + **Go**
client → 82,768 req/s. The client mattered as much as the server — Node's
own concurrency model was still capping the number even with the pooling
fix from earlier in this section.

**The real number, on the phone, real data (2026-08-07): Go server + Go
client, single process each (no manual multi-core workaround needed at
all — goroutines use all 8 cores within one process, sidestepping every
`node:cluster` problem documented above), against the real 2,880,315-
prefix `current.mmdb`: peak 37,299 req/s (concurrency=25), sustained
32,200–37,299 req/s from concurrency=25 through 1600.** This is within
range of the founder's recalled ~40K figure — the earlier ~9,100 req/s
Node-only number undercounted the phone's real capacity by roughly 4x,
purely from client-side and runtime limitations, not anything about the
server or the phone's hardware.

**Open question this raises, stated rather than glossed over:** the
"18,900 req/s on a real 4-vCPU box" figure in `mmdb-export.ts`'s own
header comment (2026-07-28) doesn't record what client measured it. Given
this session's phone — 8 mobile ARM cores — just cleared that number by
roughly 2x using a proper client, the 4-vCPU figure was very likely
undercounted by the same class of mistake documented here, not a sign the
phone outperforms real server hardware. **That comment should be treated
as unreliable until re-measured with this same Go-client methodology on
real server hardware** — flagging it here rather than silently trusting a
number this session just demonstrated the failure mode of.
