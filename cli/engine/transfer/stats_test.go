package transfer

// ReportStats, and the receive loop's own stats report, for a request-link
// drop that stops after Accept (S1-ENG-10, E-32, D-006). Every report goes to
// a local httptest stub, and a test with no stats URL proves that no request
// was even attempted. Like hash_test.go these swap os.Stdout, and noRequests
// swaps a package-level transport, so none may call t.Parallel.

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// statsStub is a local POST /api/stats/report that keeps every body it got.
type statsStub struct {
	url   string
	mu    sync.Mutex
	posts []string
}

func newStatsStub(t *testing.T) *statsStub {
	t.Helper()
	s := &statsStub{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/stats/report" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<10))
		s.mu.Lock()
		s.posts = append(s.posts, string(body))
		s.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	s.url = srv.URL
	return s
}

// got returns a copy of the bodies posted so far.
func (s *statsStub) got() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.posts...)
}

// roundTripFunc is an http.RoundTripper made of a function.
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// noRequests swaps http.DefaultTransport, which reportBytesToServer's client
// uses, for one that counts what it is handed and sends nothing, for the
// cases with no stats URL, where there is no stub to point at: the count
// proves that no request was even attempted, to any server.
func noRequests(t *testing.T) *atomic.Int32 {
	t.Helper()
	var n atomic.Int32
	orig := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		n.Add(1)
		return nil, errors.New("this test allows no request")
	})
	t.Cleanup(func() { http.DefaultTransport = orig })
	return &n
}

// doneSum is the sum a lane keeps from OnFileDone.
func doneSum(done []FileDone) int64 {
	var sum int64
	for _, d := range done {
		sum += d.Bytes
	}
	return sum
}

// An empty stats URL is the opt-out on every surface (--no-report,
// FLOE_NO_STATS=1, the desktop switch off): nothing is sent, anywhere.
func TestReportStatsEmptyURLNeverPosts(t *testing.T) {
	attempts := noRequests(t)
	ReportStats("", 12345)
	if n := attempts.Load(); n != 0 {
		t.Fatalf("ReportStats with no stats URL attempted %d requests, want 0", n)
	}
}

// A stopped drop that saved nothing has nothing to count, and a negative sum
// could only be a bug: neither posts.
func TestReportStatsZeroBytesNeverPosts(t *testing.T) {
	stub := newStatsStub(t)
	ReportStats(stub.url, 0)
	ReportStats(stub.url, -1)
	if got := stub.got(); len(got) != 0 {
		t.Fatalf("ReportStats posted %q for counts of zero and less, want nothing", got)
	}
}

// One call is one POST, carrying exactly the count it was given in the shape
// the server validates.
func TestReportStatsPostsOnce(t *testing.T) {
	stub := newStatsStub(t)
	ReportStats(stub.url, 4321)
	if got := stub.got(); len(got) != 1 || got[0] != `{"bytes":4321}` {
		t.Fatalf("stats posts %q, want exactly one {\"bytes\":4321}", got)
	}
}

// TestCompletedDropReportsExactlyOnceFromTheEngine (VR2-15, rewritten for
// E-32): a transfer that completes is reported by the receive loop itself,
// once, with the sum of the bytes it wrote, and not at all without a stats
// URL. The desktop lane reports only a drop that did not complete, so no drop
// is counted twice.
func TestCompletedDropReportsExactlyOnceFromTheEngine(t *testing.T) {
	a, b := randomBytes(t, 3000), randomBytes(t, 70000)
	total := len(a) + len(b)
	send := func(h *handSender) handResult {
		h.t.Helper()
		h.meta("a.bin", len(a), 1, 2, total)
		h.bytes(a)
		h.text(endWithSHA256(hexSHA256(a)))
		h.meta("b.bin", len(b), 2, 2, total)
		h.bytes(b)
		h.text(endWithSHA256(hexSHA256(b)))
		return h.finish()
	}

	t.Run("with a stats URL", func(t *testing.T) {
		stub := newStatsStub(t)
		res := send(newHandSenderStats(t, t.TempDir(), stub.url, ReceiveOptions{}))
		if res.err != nil {
			t.Fatalf("receive failed: %v", res.err)
		}
		if sum := doneSum(res.fileDone); len(res.fileDone) != 2 || sum != int64(total) {
			t.Fatalf("OnFileDone = %+v, want both files, %d bytes", res.fileDone, total)
		}
		if got := stub.got(); len(got) != 1 || got[0] != fmt.Sprintf(`{"bytes":%d}`, total) {
			t.Fatalf("stats posts %q, want exactly one with the %d bytes written", got, total)
		}
	})

	t.Run("without a stats URL", func(t *testing.T) {
		attempts := noRequests(t)
		res := send(newHandSenderStats(t, t.TempDir(), "", ReceiveOptions{}))
		if res.err != nil {
			t.Fatalf("receive failed: %v", res.err)
		}
		if n := attempts.Load(); n != 0 {
			t.Fatalf("a receive with no stats URL attempted %d requests, want 0", n)
		}
	})
}

// TestStoppedDropReportsNothingFromTheEngine: a drop the receiving side stops
// mid file 2, the way the desktop lane's Cancel drop does (AbortWithCode from
// another goroutine, then the close), makes the engine post nothing. The
// OnFileDone sum the lane keeps is file 1's bytes exactly, without the
// in-flight .part, and the lane's one ReportStats call posts that sum once.
func TestStoppedDropReportsNothingFromTheEngine(t *testing.T) {
	stub := newStatsStub(t)
	midFile2 := make(chan struct{})
	var once sync.Once
	h := newHandSenderStats(t, t.TempDir(), stub.url, ReceiveOptions{
		OnProgress: func(p Progress) {
			if p.FileIndex == 2 && p.FileBytes > 0 {
				once.Do(func() { close(midFile2) })
			}
		},
	})
	first, second := randomBytes(t, 3000), randomBytes(t, 64<<10)
	total := len(first) + len(second)
	h.meta("first.bin", len(first), 1, 2, total)
	h.bytes(first)
	h.text(endWithSHA256(hexSHA256(first)))
	h.meta("second.bin", len(second), 2, 2, total)
	h.bytes(second[:16<<10])
	select {
	case <-midFile2:
	case <-time.After(20 * time.Second):
		t.Fatal("file 2's bytes never reached the receiver")
	}
	go func() {
		AbortWithCode(h.rdc, "test-ver", CodeStopped, CodeStopped.WireReason(), 1)
		_ = h.rdc.Close()
	}()
	res := h.finish()

	if res.err == nil {
		t.Fatal("the receive reported success for a stopped drop")
	}
	if stop := findRefusal(t, res.frames); stop.Code != string(CodeStopped) {
		t.Fatalf("the sender was told %q, want %q", stop.Code, CodeStopped)
	}
	if got := stub.got(); len(got) != 0 {
		t.Fatalf("the engine posted %q for a drop that stopped, want nothing", got)
	}
	sum := doneSum(res.fileDone)
	if len(res.fileDone) != 1 || res.fileDone[0].SavedName != "first.bin" || sum != int64(len(first)) {
		t.Fatalf("OnFileDone = %+v, want first.bin alone, %d bytes", res.fileDone, len(first))
	}
	if left := listDir(t, h.dir); len(left) != 1 || left[0] != "first.bin" {
		t.Fatalf("on disk: %v, want first.bin alone (the cut-off file's .part removed)", left)
	}

	ReportStats(stub.url, sum) // what the desktop lane does with the sum
	if got := stub.got(); len(got) != 1 || got[0] != fmt.Sprintf(`{"bytes":%d}`, len(first)) {
		t.Fatalf("stats posts %q, want exactly one with file 1's %d bytes", got, len(first))
	}
}

// TestHashMismatchedFileIsNotInFileDoneSum: a sender whose second file's
// digest is off by one hex digit (what the e2ehost -corrupt-hash flag does)
// has that file refused. OnFileDone never fires for it, so the sum a lane
// reports is file 1's bytes alone, and the engine posts nothing for the
// refused drop.
func TestHashMismatchedFileIsNotInFileDoneSum(t *testing.T) {
	stub := newStatsStub(t)
	h := newHandSenderStats(t, t.TempDir(), stub.url, ReceiveOptions{})
	first, second := randomBytes(t, 3000), randomBytes(t, 5000)
	total := len(first) + len(second)
	h.meta("first.bin", len(first), 1, 2, total)
	h.bytes(first)
	h.text(endWithSHA256(hexSHA256(first)))
	h.meta("second.bin", len(second), 2, 2, total)
	h.bytes(second)
	digest := []byte(hexSHA256(second))
	if digest[63] == 'a' {
		digest[63] = 'b'
	} else {
		digest[63] = 'a'
	}
	h.text(endWithSHA256(string(digest)))
	res := h.finish()

	var refused *RefusedError
	if !errors.As(res.err, &refused) || refused.Code != CodeHashMismatch {
		t.Fatalf("receiver error = %v, want a hash-mismatch refusal", res.err)
	}
	sum := doneSum(res.fileDone)
	if len(res.fileDone) != 1 || res.fileDone[0].SavedName != "first.bin" || sum != int64(len(first)) {
		t.Fatalf("OnFileDone = %+v, want first.bin alone, %d bytes", res.fileDone, len(first))
	}
	if got := stub.got(); len(got) != 0 {
		t.Fatalf("the engine posted %q for a refused drop, want nothing", got)
	}
	ReportStats(stub.url, sum)
	if got := stub.got(); len(got) != 1 || got[0] != fmt.Sprintf(`{"bytes":%d}`, len(first)) {
		t.Fatalf("stats posts %q, want exactly one with file 1's %d bytes", got, len(first))
	}
}
