package ice

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// fetchPrinted runs FetchDetail against a server that answers with handler
// and returns what it printed to stdout.
func fetchPrinted(t *testing.T, handler http.HandlerFunc) (out string, degraded bool) {
	t.Helper()
	srv := httptest.NewServer(handler)
	defer srv.Close()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	orig := os.Stdout
	os.Stdout = w
	var buf bytes.Buffer
	drained := make(chan struct{})
	go func() { defer close(drained); _, _ = io.Copy(&buf, r) }()
	_, degraded, ferr := FetchDetail(srv.URL)
	os.Stdout = orig
	_ = w.Close()
	<-drained
	_ = r.Close()
	if ferr != nil {
		t.Fatalf("FetchDetail returned an error: %v", ferr)
	}
	return buf.String(), degraded
}

// TestFetchDetailWarnsWhenTheAnswerIsUnreadable (A4-B19, A8b-B5): a 200 whose
// body is not a list of ICE servers, or a list with nothing to connect with,
// falls back to public STUN like an unreachable server or a non-200 answer,
// and says so in the same form. It used to fall back in silence, so a reverse
// proxy that answers /api/ with a web page cost the relay with no line at all
// and a transfer that needed it ended as a plain timeout.
func TestFetchDetailWarnsWhenTheAnswerIsUnreadable(t *testing.T) {
	const want = "  Warning: could not read TURN credentials from the signaling server. Using STUN only.\n"
	for name, body := range map[string]string{
		"a web page":            `<html>nope</html>`,
		"an empty list":         `[]`,
		"a list with no urls":   `[{}]`,
		"an object, not a list": `{"urls":"turn:a:3478"}`,
	} {
		t.Run(name, func(t *testing.T) {
			out, degraded := fetchPrinted(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(body)) })
			if !degraded {
				t.Error("the fallback was not reported as degraded")
			}
			if out != want {
				t.Fatalf("printed %q, want %q", out, want)
			}
		})
	}

	// A readable answer prints nothing, a relay-less one included.
	out, degraded := fetchPrinted(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[{"urls":"stun:127.0.0.1:9"}]`))
	})
	if degraded || out != "" {
		t.Fatalf("a readable answer printed %q (degraded %v), want nothing", out, degraded)
	}
}
