// Minimal HTTP lookup server over a built .mmdb file, in Go. Same purpose
// and same wire contract as scripts/mmdb-bench/server.mjs (GET /lookup/<ip>
// -> JSON, GET /health -> "ok") specifically so the existing loadtest.mjs
// works unchanged against either one — the comparison is the language and
// runtime, not the benchmark methodology.
package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/oschwald/maxminddb-golang"
)

func main() {
	mmdbPath := "current.mmdb"
	if len(os.Args) > 1 {
		mmdbPath = os.Args[1]
	}
	port := "8299"
	if len(os.Args) > 2 {
		port = os.Args[2]
	}

	db, err := maxminddb.Open(mmdbPath)
	if err != nil {
		log.Fatalf("failed to open %s: %v", mmdbPath, err)
	}
	defer db.Close()
	log.Printf("[pid %d] loaded %s", os.Getpid(), mmdbPath)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("/lookup/", func(w http.ResponseWriter, r *http.Request) {
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
	})

	log.Printf("[pid %d] listening on :%s", os.Getpid(), port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
