// Concurrency-ramp load test, same methodology as scripts/mmdb-bench/loadtest.mjs
// (scattered random IPs, warmup discarded, percentile latencies) but in Go —
// so goroutines generate the load, removing any question of the client
// itself being the bottleneck the way a single Node process can be.
package main

import (
	"crypto/tls"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

func randomIP() string {
	return fmt.Sprintf("%d.%d.%d.%d", 1+rand.Intn(223), rand.Intn(256), rand.Intn(256), rand.Intn(256))
}

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(p / 100 * float64(len(sorted)))
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

func runLevel(client *http.Client, baseURL string, concurrency int, windowMs int, warmupMs int) {
	var completed int64
	var errors int64
	var mu sync.Mutex
	var latencies []float64
	stop := int32(0)

	worker := func() {
		for atomic.LoadInt32(&stop) == 0 {
			t0 := time.Now()
			req, err := http.NewRequest("GET", baseURL+"/lookup/"+randomIP(), nil)
			if err != nil {
				atomic.AddInt64(&errors, 1)
				continue
			}
			// Only set when BENCH_TOKEN is present, so plain (no-auth)
			// servers are measured with exactly the request they'd
			// otherwise get — an unused header still costs bytes on the
			// wire and would skew the comparison it exists to make.
			if tok := os.Getenv("BENCH_TOKEN"); tok != "" {
				req.Header.Set("Authorization", "Bearer "+tok)
			}
			resp, err := client.Do(req)
			if err != nil {
				atomic.AddInt64(&errors, 1)
				continue
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			dt := time.Since(t0).Seconds() * 1000
			if resp.StatusCode < 400 {
				atomic.AddInt64(&completed, 1)
				mu.Lock()
				latencies = append(latencies, dt)
				mu.Unlock()
			} else {
				atomic.AddInt64(&errors, 1)
			}
		}
	}

	var wg sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			worker()
		}()
	}

	time.Sleep(time.Duration(warmupMs) * time.Millisecond)
	atomic.StoreInt64(&completed, 0)
	atomic.StoreInt64(&errors, 0)
	mu.Lock()
	latencies = nil
	mu.Unlock()

	started := time.Now()
	time.Sleep(time.Duration(windowMs) * time.Millisecond)
	atomic.StoreInt32(&stop, 1)
	wg.Wait()
	elapsed := time.Since(started).Seconds()

	mu.Lock()
	sort.Float64s(latencies)
	mu.Unlock()

	rps := float64(completed) / elapsed
	fmt.Printf("concurrency=%4d  rps=%7.0f  p50=%.1fms  p95=%.1fms  p99=%.1fms  errors=%d\n",
		concurrency, rps, percentile(latencies, 50), percentile(latencies, 95), percentile(latencies, 99), errors)
}

func main() {
	baseURL := "http://127.0.0.1:8299"
	if len(os.Args) > 1 {
		baseURL = os.Args[1]
	}
	levelsStr := "1,5,10,25,50,100,200,400,800,1600"
	if len(os.Args) > 2 {
		levelsStr = os.Args[2]
	}
	windowMs := 5000
	if len(os.Args) > 3 {
		windowMs, _ = strconv.Atoi(os.Args[3])
	}

	var levels []int
	for _, s := range strings.Split(levelsStr, ",") {
		n, _ := strconv.Atoi(strings.TrimSpace(s))
		levels = append(levels, n)
	}

	transport := &http.Transport{
		MaxIdleConns:        10000,
		MaxIdleConnsPerHost: 10000,
		MaxConnsPerHost:     0, // unlimited
		IdleConnTimeout:     90 * time.Second,
		// The production-shaped server (prod.go) serves TLS with a
		// self-signed cert generated at startup, so verification would
		// fail for a reason that has nothing to do with throughput.
		// Only affects https:// targets.
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}
	client := &http.Client{Transport: transport}

	fmt.Printf("Target: %s\n", baseURL)
	fmt.Printf("Concurrency levels: %v, %dms each\n\n", levels, windowMs)

	for _, c := range levels {
		runLevel(client, baseURL, c, windowMs, 500)
	}
}
