// rdns: read "ip" or "ip:port" lines on stdin, emit "ip<TAB>ports<TAB>domain".
//
//	cat targets.txt | rdns
//	some-scanner | rdns -c 64 -t 1s | grep example.com
//	cat targets.txt | rdns | cut -f1,3
//
// Lines sharing an IP are merged into one row with their ports comma-joined
// (deduped, first-seen order), so each IP is looked up only once. Because of
// the grouping, all of stdin is read before output begins; rows then stream in
// first-seen order as lookups resolve. Output is tab-separated for cut/awk/grep
// (use -F'\t' / cut so the empty port field on portless lines stays put).
// Diagnostics (if any) go to stderr so the stdout pipe stays clean.
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

	// Read everything first, grouping ports by IP. Grouping means a row can't be
	// emitted until stdin closes (a duplicate IP may appear on the last line).
	type entry struct {
		ports []string
		seen  map[string]bool // dedupe repeated ports
	}
	byIP := map[string]*entry{}
	order := []string{} // IPs in first-seen order

	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024) // tolerate long lines
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		ip, port := splitTarget(line)
		e := byIP[ip]
		if e == nil {
			e = &entry{seen: map[string]bool{}}
			byIP[ip] = e
			order = append(order, ip)
		}
		if port != "" && !e.seen[port] {
			e.seen[port] = true
			e.ports = append(e.ports, port)
		}
	}
	if err := sc.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "rdns: read error:", err)
	}

	// One lookup per unique IP, bounded concurrency. Each worker drops its
	// finished row into a buffered(1) channel so it never waits on the writer.
	sem := make(chan struct{}, *workers)
	rows := make([]chan string, len(order))
	for i, ip := range order {
		ch := make(chan string, 1)
		rows[i] = ch
		sem <- struct{}{}
		go func(ip, ports string, ch chan string) {
			defer func() { <-sem }()
			ctx, cancel := context.WithTimeout(context.Background(), *timeout)
			defer cancel()
			domain := ""
			if names, err := net.DefaultResolver.LookupAddr(ctx, ip); err == nil && len(names) > 0 {
				domain = strings.TrimSuffix(names[0], ".")
			}
			ch <- row(ip, ports, domain)
		}(ip, strings.Join(byIP[ip].ports, ","), ch)
	}

	// Writer: drain in first-seen order, straight to stdout so rows stream as
	// they resolve and nothing is stranded in a buffer on interrupt.
	if *header {
		fmt.Fprintln(os.Stdout, "ip\tports\tdomain")
	}
	for _, ch := range rows {
		fmt.Fprintln(os.Stdout, <-ch)
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
