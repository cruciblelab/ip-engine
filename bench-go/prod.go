// "Production-shaped" variant of main.go: same mmdb lookup, but wrapped in
// the middleware chain ipreadout-service's PLAN.md actually specifies
// (Recover -> Logging -> Auth -> RateLimit -> Usage -> handler) and served
// over TLS, because that is what a real customer request costs. Exists to
// measure the gap between "raw mmdb read over plaintext loopback HTTP" —
// which is all main.go measures — and a request a paying customer would
// actually make. Run with -tls=false / -mw=false to isolate each factor.
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"flag"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/oschwald/maxminddb-golang"
	"golang.org/x/time/rate"
)

// --- auth: sha256 of presented key, cache map guarded by RWMutex, matching
// PLAN.md's internal/auth/validator.go design.
type validator struct {
	mu    sync.RWMutex
	cache map[[32]byte]int64
}

func (v *validator) validate(token string) (int64, bool) {
	sum := sha256.Sum256([]byte(token))
	v.mu.RLock()
	id, ok := v.cache[sum]
	v.mu.RUnlock()
	return id, ok
}

// --- usage: in-memory counter per key, flushed by a ticker (the flush
// itself is a no-op here; the point is the hot-path atomic, not the DB).
type usage struct {
	mu       sync.RWMutex
	counters map[int64]*atomic.Int64
}

func (u *usage) incr(keyID int64) {
	u.mu.RLock()
	c, ok := u.counters[keyID]
	u.mu.RUnlock()
	if !ok {
		u.mu.Lock()
		c = &atomic.Int64{}
		u.counters[keyID] = c
		u.mu.Unlock()
	}
	c.Add(1)
}

// --- rate limit: one token bucket per key.
type limiter struct {
	mu      sync.RWMutex
	buckets map[int64]*rate.Limiter
}

func (l *limiter) allow(keyID int64) bool {
	l.mu.RLock()
	b, ok := l.buckets[keyID]
	l.mu.RUnlock()
	if !ok {
		l.mu.Lock()
		b = rate.NewLimiter(rate.Limit(1e9), 1e9) // effectively unlimited: measuring cost, not enforcing
		l.buckets[keyID] = b
		l.mu.Unlock()
	}
	return b.Allow()
}

func selfSignedCert() tls.Certificate {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		log.Fatal(err)
	}
	tmpl := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:     x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		log.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func main() {
	useTLS := flag.Bool("tls", true, "serve over TLS")
	useMW := flag.Bool("mw", true, "run the auth/ratelimit/usage/logging middleware chain")
	useLog := flag.Bool("log", true, "emit one structured log line per request (part of -mw)")
	port := flag.String("port", "8399", "port")
	flag.Parse()

	mmdbPath := "current.mmdb"
	if flag.NArg() > 0 {
		mmdbPath = flag.Arg(0)
	}

	db, err := maxminddb.Open(mmdbPath)
	if err != nil {
		log.Fatalf("failed to open %s: %v", mmdbPath, err)
	}
	defer db.Close()

	const testToken = "ipk_live_benchmarkkey"
	v := &validator{cache: map[[32]byte]int64{sha256.Sum256([]byte(testToken)): 1}}
	u := &usage{counters: map[int64]*atomic.Int64{}}
	l := &limiter{buckets: map[int64]*rate.Limiter{}}

	// Logs go to a file, like a real deployment — not to a terminal, which
	// would make this measure the terminal instead of the logging.
	// os.TempDir() rather than a hardcoded "/tmp/...": on Termux, "/tmp"
	// isn't writable — the real tmp dir is under $PREFIX, which is exactly
	// what TMPDIR (and therefore os.TempDir()) resolves to there.
	logFile, err := os.OpenFile(
		filepath.Join(os.TempDir(), "prod-bench.log"),
		os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644,
	)
	if err != nil {
		log.Fatal(err)
	}
	defer logFile.Close()
	reqLog := log.New(logFile, "", log.LstdFlags)

	lookup := func(w http.ResponseWriter, r *http.Request) {
		ipStr := strings.TrimPrefix(r.URL.Path, "/lookup/")
		ip := net.ParseIP(ipStr)
		if ip == nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var record interface{}
		if err := db.Lookup(ip, &record); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if record == nil {
			record = map[string]interface{}{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(record)
	}

	var handler http.Handler = http.HandlerFunc(lookup)

	if *useMW {
		inner := handler
		handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					w.WriteHeader(http.StatusInternalServerError)
				}
			}()
			start := time.Now()

			// Auth
			authz := r.Header.Get("Authorization")
			token := strings.TrimPrefix(authz, "Bearer ")
			keyID, ok := v.validate(token)
			if !ok {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			// RateLimit
			if !l.allow(keyID) {
				w.WriteHeader(http.StatusTooManyRequests)
				return
			}
			// Usage
			u.incr(keyID)

			inner.ServeHTTP(w, r)

			if *useLog {
				reqLog.Printf("key=%d path=%s dur=%s", keyID, r.URL.Path, time.Since(start))
			}
		})
	}

	mux := http.NewServeMux()
	mux.Handle("/lookup/", handler)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") })

	srv := &http.Server{Addr: ":" + *port, Handler: mux}
	log.Printf("listening on :%s (tls=%v middleware=%v log=%v)", *port, *useTLS, *useMW, *useLog)
	if *useTLS {
		srv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{selfSignedCert()}}
		log.Fatal(srv.ListenAndServeTLS("", ""))
	}
	log.Fatal(srv.ListenAndServe())
}
