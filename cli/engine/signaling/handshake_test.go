package signaling

import (
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

// TestConnectKeepsTheHandshakeStatus: a server that answers the /ws upgrade
// with an HTTP status has said something a person can act on, and Connect
// used to throw it away (`conn, _, err`). 403 is the Origin check, which is
// what a reverse proxy that rewrites Host produces; 404 is a proxy that does
// not forward /ws; 502 is a proxy with nothing behind it. All three read
// "websocket: bad handshake".
func TestConnectKeepsTheHandshakeStatus(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusNotFound, http.StatusBadGateway} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			// The body and the headers are the server's text, or a proxy's.
			// None of it may reach the error: only the number does.
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-From-The-Far-End", "header-text-from-the-far-end")
				w.WriteHeader(status)
				_, _ = w.Write([]byte("body-text-from-the-far-end <script>"))
			}))
			defer srv.Close()

			c, err := Connect(srv.URL)
			if err == nil {
				c.Close()
				t.Fatal("Connect succeeded against a server that refused the upgrade")
			}
			var refused *HandshakeError
			if !errors.As(err, &refused) {
				t.Fatalf("error = %v (%T), want a *HandshakeError in its chain", err, err)
			}
			if refused.Status != status {
				t.Fatalf("HandshakeError.Status = %d, want %d", refused.Status, status)
			}
			// A caller that asked this before the status was kept still gets yes.
			if !errors.Is(err, websocket.ErrBadHandshake) {
				t.Fatalf("errors.Is(err, websocket.ErrBadHandshake) is false for %v", err)
			}
			text := err.Error()
			// The words the docs quote stay, and the status follows them.
			if want := "websocket: bad handshake (HTTP " + strconv.Itoa(status) + ")"; !strings.HasSuffix(text, want) {
				t.Fatalf("error text = %q, want it to end with %q", text, want)
			}
			for _, leak := range []string{"body-text", "header-text", "<script>"} {
				if strings.Contains(text, leak) {
					t.Fatalf("the far end's text %q reached the error: %q", leak, text)
				}
			}
		})
	}
}

// TestConnectFailureWithoutAResponseIsNotAHandshakeError: nothing answered,
// so there is no status to keep, and the error must not claim one.
func TestConnectFailureWithoutAResponseIsNotAHandshakeError(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	c, err := Connect("http://" + addr)
	if err == nil {
		c.Close()
		t.Fatal("Connect succeeded against a closed port")
	}
	var refused *HandshakeError
	if errors.As(err, &refused) {
		t.Fatalf("a refused TCP connection was reported as an HTTP answer: %v", err)
	}
	if strings.Contains(err.Error(), "(HTTP ") {
		t.Fatalf("the error names a status nobody sent: %q", err)
	}
}
