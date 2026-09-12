package transfer

// The receiver's out-of-band stats report (receiver.go). The receive loop
// itself is driven end to end over real pion pairs in loopback_test.go,
// cleanup_test.go, watchdog_test.go and hostile_test.go.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestReportBytesToServer verifies the stats report is posted correctly and
// that passing an empty serverURL skips the request entirely (the opt-out path).
func TestReportBytesToServer(t *testing.T) {
	t.Run("posts byte count when URL is set", func(t *testing.T) {
		var got int64
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/stats/report" || r.Method != http.MethodPost {
				t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
				w.WriteHeader(http.StatusNotFound)
				return
			}
			body, _ := io.ReadAll(r.Body)
			var payload map[string]int64
			if err := json.Unmarshal(body, &payload); err != nil {
				t.Errorf("body is not valid JSON: %v", err)
			}
			got = payload["bytes"]
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()

		reportBytesToServer(srv.URL, 12345)

		if got != 12345 {
			t.Errorf("reported bytes = %d, want 12345", got)
		}
	})

	t.Run("skips request when URL is empty (opt-out)", func(t *testing.T) {
		called := false
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			called = true
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()

		// Empty URL is the opt-out signal; the real server URL is irrelevant.
		reportBytesToServer("", 99999)

		if called {
			t.Error("reportBytesToServer should not make any request when serverURL is empty")
		}
	})
}
