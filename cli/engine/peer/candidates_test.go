package peer

// F2-CPQA-01 (DV-AUDIT CP-QA): the ICE candidates a peer trickles before the
// remote description is set wait in pendingCandidates, and the peer chooses how
// many and how large they are. The bounds are literals here, as in
// flood_test.go, so these tests also run against code that predates the
// constants (maxPendingCandidates, maxPendingCandidateBytes).

import (
	"fmt"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	pendingCountBound = 64
	pendingByteBound  = 64 << 10
)

// pendingNow is the buffered count and the peer-chosen bytes it holds (the
// three strings of each candidate).
func pendingNow(conn *Connection) (n, held int) {
	conn.mu.Lock()
	defer conn.mu.Unlock()
	for _, c := range conn.pendingCandidates {
		held += len(c.Candidate)
		if c.SDPMid != nil {
			held += len(*c.SDPMid)
		}
		if c.UsernameFragment != nil {
			held += len(*c.UsernameFragment)
		}
	}
	return len(conn.pendingCandidates), held
}

// settledPending waits until the buffered count has not changed for 500 ms
// (at most most) and returns it with the bytes it holds.
func settledPending(conn *Connection, most time.Duration) (n, held int) {
	last, since := -1, time.Now()
	for deadline := time.Now().Add(most); time.Now().Before(deadline); {
		time.Sleep(25 * time.Millisecond)
		if n, _ = pendingNow(conn); n != last {
			last, since = n, time.Now()
		} else if time.Since(since) >= 500*time.Millisecond {
			break
		}
	}
	return pendingNow(conn)
}

// hostCandidate is a candidate line of the shape and size a real peer sends.
func hostCandidate(i int) webrtc.ICECandidateInit {
	mid, line := "0", uint16(0)
	return webrtc.ICECandidateInit{
		Candidate:     fmt.Sprintf("candidate:%d 1 udp 2130706431 192.0.2.%d %d typ host generation 0", 1000+i, i%250+1, 50000+i),
		SDPMid:        &mid,
		SDPMLineIndex: &line,
	}
}

// TestPendingCandidatesAreBounded holds addRemoteCandidate's buffer, before the
// remote description, to the count and the byte bound, keeping the first ones
// and dropping the rest without an error.
func TestPendingCandidatesAreBounded(t *testing.T) {
	t.Run("count", func(t *testing.T) {
		conn := &Connection{}
		for i := 0; i < 1000; i++ {
			conn.addRemoteCandidate(hostCandidate(i))
		}
		n, held := pendingNow(conn)
		t.Logf("1000 real-sized candidates: %d buffered, %d bytes", n, held)
		if n != pendingCountBound {
			t.Fatalf("%d candidates buffered, want the first %d", n, pendingCountBound)
		}
		if conn.pendingCandidates[0].Candidate != hostCandidate(0).Candidate {
			t.Fatal("the first candidate is not the one kept first")
		}
	})
	t.Run("bytes", func(t *testing.T) {
		conn := &Connection{}
		big := strings.Repeat("a", 900_000)
		ufrag := strings.Repeat("u", 900_000)
		mid := strings.Repeat("m", 900_000)
		for i := 0; i < 10; i++ {
			conn.addRemoteCandidate(webrtc.ICECandidateInit{Candidate: big})
			conn.addRemoteCandidate(webrtc.ICECandidateInit{Candidate: "candidate:1 1 udp 1 192.0.2.1 9 typ host", UsernameFragment: &ufrag})
			conn.addRemoteCandidate(webrtc.ICECandidateInit{Candidate: "candidate:1 1 udp 1 192.0.2.1 9 typ host", SDPMid: &mid})
		}
		n, held := pendingNow(conn)
		t.Logf("30 candidates of 900,000 peer bytes each: %d buffered, %d bytes", n, held)
		if held > pendingByteBound {
			t.Fatalf("%d bytes buffered, want at most %d", held, pendingByteBound)
		}
		// The oversized ones never crowd out a real one that arrives after them.
		conn.addRemoteCandidate(hostCandidate(1))
		if n2, _ := pendingNow(conn); n2 != n+1 {
			t.Fatalf("a real candidate after the oversized ones was not kept (%d then %d)", n, n2)
		}
	})
}

// TestCandidateFloodBeforeTheAnswerIsBounded is the audit's reproduction
// through the package's fake /ws server: the host's offer is out, and the
// visitor, who never answers, relays candidates that are 900,000 bytes each
// (just under the server's 1 MB frame cap), then hundreds of real-sized ones.
// Before, every one of them stayed buffered for the whole answer wait
// (F2-CPQA-01: nothing bounded the list).
func TestCandidateFloodBeforeTheAnswerIsBounded(t *testing.T) {
	shrinkSignalWait(t, 25*time.Second)
	conn, s := joinedConnection(t, "sender")
	done := runSetup(conn.SetupAsSender)
	waitSignal(t, s, "offer")

	runtime.GC()
	var m0 runtime.MemStats
	runtime.ReadMemStats(&m0)

	write := func(c webrtc.ICECandidateInit) {
		frame := map[string]any{"type": "signal", "sender": "visitor", "signal": map[string]any{"candidate": c}}
		if err := s.ws.WriteJSON(frame); err != nil {
			t.Fatalf("write: %v", err)
		}
		// Paced like a relay, so the client's non-blocking hand-offs are not
		// what decides the count.
		time.Sleep(time.Millisecond)
	}
	big := strings.Repeat("a", 900_000)
	const large, small = 80, 300
	start := time.Now()
	for i := 0; i < large; i++ {
		write(webrtc.ICECandidateInit{Candidate: big})
	}
	for i := 0; i < small; i++ {
		write(hostCandidate(i))
	}
	n, held := settledPending(conn, 15*time.Second)
	runtime.GC()
	var m1 runtime.MemStats
	runtime.ReadMemStats(&m1)
	t.Logf("frames sent=%d (%d of 900,000 bytes) pending=%d held=%d bytes heap in use %+d KiB in %v",
		large+small, large, n, held, (int64(m1.HeapInuse)-int64(m0.HeapInuse))>>10, time.Since(start).Round(time.Millisecond))

	select {
	case err := <-done:
		t.Fatalf("setup ended during the flood: %v", err)
	default:
	}
	if n > pendingCountBound || held > pendingByteBound {
		t.Fatalf("%d candidates and %d bytes buffered, want at most %d and %d", n, held, pendingCountBound, pendingByteBound)
	}
	if n == 0 {
		t.Fatal("nothing was buffered: the flood never reached addRemoteCandidate")
	}
}

// TestBufferedCandidatesStillConnect is a normal setup whose candidates all
// arrive before its answer: every one of them goes through the buffer, none is
// dropped, and the connection forms from them alone (the host's own candidates
// are never passed to the answerer, so nothing else could pair the two).
func TestBufferedCandidatesStillConnect(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback setup in -short mode")
	}
	conn, s := joinedConnection(t, "sender")
	done := make(chan error, 1)
	go func() {
		dc, err := conn.SetupAsSender()
		if err == nil && dc.ReadyState() != webrtc.DataChannelStateOpen {
			err = fmt.Errorf("setup returned a channel in state %s", dc.ReadyState())
		}
		done <- err
	}()
	offer := waitSignal(t, s, "offer")

	// The answerer is shaped like the engine's own (the same address filter),
	// on IPv4 UDP only, so its host candidates are few and real.
	se := webrtc.SettingEngine{}
	se.SetIPFilter(keepICEIP)
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(se)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("answerer: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		t.Fatalf("answerer remote description: %v", err)
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("answerer answer: %v", err)
	}
	var mu sync.Mutex
	var cands []webrtc.ICECandidateInit
	gathered := make(chan struct{})
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		mu.Lock()
		defer mu.Unlock()
		if c == nil {
			close(gathered)
			return
		}
		cands = append(cands, c.ToJSON())
	})
	if err := pc.SetLocalDescription(answer); err != nil {
		t.Fatalf("answerer local description: %v", err)
	}
	select {
	case <-gathered:
	case <-time.After(10 * time.Second):
		t.Fatal("the answerer never finished gathering")
	}
	mu.Lock()
	cands = append([]webrtc.ICECandidateInit(nil), cands...)
	mu.Unlock()
	if len(cands) == 0 {
		t.Skip("no IPv4 host candidate on this machine")
	}
	for _, c := range cands {
		if err := s.ws.WriteJSON(map[string]any{"type": "signal", "signal": map[string]any{"candidate": c}}); err != nil {
			t.Fatalf("write candidate: %v", err)
		}
	}
	if n, _ := settledPending(conn, 5*time.Second); n != len(cands) {
		t.Fatalf("%d of the answerer's %d candidates buffered before its answer", n, len(cands))
	}
	sendSignal(t, s, "answer", answer.SDP)

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("setup with %d buffered candidates: %v", len(cands), err)
		}
		t.Logf("connected from %d candidates that all waited in the buffer", len(cands))
	case <-time.After(20 * time.Second):
		t.Fatal("setup did not connect within 20 s")
	}
}
