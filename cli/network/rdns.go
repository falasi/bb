// rdns: read "ip" or "ip:port" lines on stdin, emit "ip<TAB>port<TAB>domain" on stdout.
//
//	cat targets.txt | rdns
//	some-scanner | rdns -c 64 -t 1s | grep example.com
//	cat targets.txt | rdns | cut -f1,3
//
// Tab-separated so it drops straight into cut/awk/grep (use -F'\t' / cut so the
// empty port field on portless lines stays put). Concurrent lookups, output
// kept in input order, streamed line-by-line as results arrive. Diagnostics
// (if any) go to stderr so the stdout pipe stays clean.
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"net"
	"os"
	"strings"
	"time"
)

func main() {
	workers := flag.Int("c", 16, "max concurrent lookups")
	timeout := flag.Duration("t", 2*time.Second, "per-lookup timeout")
	header := flag.Bool("H", false, "emit a header row")
	flag.Parse()

	type job struct {
		ch chan string // buffered(1); the worker sends the finished row here
	}
	sem := make(chan struct{}, *workers) // caps in-flight goroutines
	jobs := make(chan job, *workers)     // preserves order for the writer

	// Producer: read stdin, fan out a bounded set of lookup goroutines.
	go func() {
		sc := bufio.NewScanner(os.Stdin)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024) // tolerate long lines
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			ch := make(chan string, 1)
			jobs <- job{ch} // enqueue first so writer sees input order
			sem <- struct{}{}
			go func(line string, ch chan string) {
				defer func() { <-sem }()
				ip, port := splitTarget(line)
				ctx, cancel := context.WithTimeout(context.Background(), *timeout)
				defer cancel()
				domain := ""
				if names, err := net.DefaultResolver.LookupAddr(ctx, ip); err == nil && len(names) > 0 {
					domain = strings.TrimSuffix(names[0], ".")
				}
				ch <- row(ip, port, domain)
			}(line, ch)
		}
		if err := sc.Err(); err != nil {
			fmt.Fprintln(os.Stderr, "rdns: read error:", err)
		}
		close(jobs)
	}()

	// Writer: drain jobs in order. Writing straight to os.Stdout means each line
	// hits the pipe immediately — output streams as results arrive, and nothing
	// is stranded in a buffer if the process is interrupted.
	if *header {
		fmt.Fprintln(os.Stdout, "ip\tport\tdomain")
	}
	for j := range jobs {
		fmt.Fprintln(os.Stdout, <-j.ch)
	}
}

// splitTarget pulls host and port from an input line. It accepts "ip",
// "ip:port", and bracketed IPv6 like "[::1]:443". When there's no port (bare
// IPv4 or unbracketed IPv6 such as "2001:db8::1"), port comes back empty and
// the host is taken as-is — SplitHostPort splitting on the first colon would
// otherwise mangle IPv6.
func splitTarget(s string) (host, port string) {
	if h, p, err := net.SplitHostPort(s); err == nil {
		return h, p
	}
	return strings.Trim(s, "[]"), "" // no port; drop any stray brackets
}

// row joins fields with tabs. PTR records can't contain tabs or newlines, so a
// plain TSV line is unambiguous and needs no quoting; we replace any stray
// whitespace just to guarantee one record per line.
func row(fields ...string) string {
	clean := strings.NewReplacer("\t", " ", "\n", " ", "\r", " ")
	out := make([]string, len(fields))
	for i, f := range fields {
		out[i] = clean.Replace(f)
	}
	return strings.Join(out, "\t")
}
