package peer

// F2-CPQA-01 (DV-AUDIT CP-QA): the ICE candidates a peer trickles, and the
// peer chooses how many and how large they are. Those that arrive before the
// remote description is set wait in pendingCandidates; the rest go straight
// to pion. The bounds are literals here, as in flood_test.go, so these tests
// also run against code that predates the constants (maxPendingCandidates,
// maxRemoteCandidates, maxCandidateBytes).

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
	remoteCountBound  = 256
	candidateByteCap  = 1 << 10
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
	// Keep the floe channel open once it arrives. With no handler, pion's
	// default OnDataChannel closes an undeclared channel at once, and that
	// close raced the ReadyState check above: 4 of 120 runs saw the channel
	// SetupAsSender returned already closed.
	pc.OnDataChannel(func(*webrtc.DataChannel) {})
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

// sizedCandidate is a valid host candidate at 198.51.100.i (TEST-NET-2, never
// routable), port 40000+i, padded with one extension so that its three
// strings come to exactly total bytes.
func sizedCandidate(i, total int) webrtc.ICECandidateInit {
	mid, line := "0", uint16(0)
	base := fmt.Sprintf("candidate:%d 1 udp 2130706431 198.51.100.%d %d typ host generation 0 x-pad ", 2000+i, i, 40000+i)
	return webrtc.ICECandidateInit{
		Candidate:     base + strings.Repeat("p", total-len(base)-len(mid)),
		SDPMid:        &mid,
		SDPMLineIndex: &line,
	}
}

// signaledRemotes is pion's own list of the remote candidates it holds that a
// peer signaled, as ip:port. Peer-reflexive ones, which pion learns by itself
// from the peer's checks, are left out.
func signaledRemotes(pc *webrtc.PeerConnection) []string {
	var out []string
	for _, st := range pc.GetStats() {
		if v, ok := st.(webrtc.ICECandidateStats); ok && v.Type == webrtc.StatsTypeRemoteCandidate &&
			v.CandidateType != webrtc.ICECandidateTypePrflx {
			out = append(out, fmt.Sprintf("%s:%d", v.IP, v.Port))
		}
	}
	return out
}

// settledRemotes waits until pion's signaled remote count has not changed for
// 500 ms (at most most) and returns the list. pion adds each candidate on a
// goroutine of its own, so the count lags the hand-off.
func settledRemotes(pc *webrtc.PeerConnection, most time.Duration) []string {
	last, since := -1, time.Now()
	for deadline := time.Now().Add(most); time.Now().Before(deadline); {
		time.Sleep(50 * time.Millisecond)
		if n := len(signaledRemotes(pc)); n != last {
			last, since = n, time.Now()
		} else if time.Since(since) >= 500*time.Millisecond {
			break
		}
	}
	return signaledRemotes(pc)
}

// connectedSender is TestBufferedCandidatesStillConnect's setup carried to a
// connected host: the offerer from New and SetupAsSender, an answerer shaped
// like the engine's own (the same address filter, IPv4 UDP), its candidates
// all buffered before its answer. It returns the host, the fake server's
// socket and how many candidates the buffer took. The host's own candidates
// never reach the answerer, and pion checks no pair once one is selected, so
// the candidates a test sends after this cause no traffic.
func connectedSender(t *testing.T) (*Connection, *setupWS, int) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping ICE loopback setup in -short mode")
	}
	conn, s := joinedConnection(t, "sender")
	done := runSetup(conn.SetupAsSender)
	offer := waitSignal(t, s, "offer")

	se := webrtc.SettingEngine{}
	se.SetIPFilter(keepICEIP)
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(se)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("answerer: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	pc.OnDataChannel(func(*webrtc.DataChannel) {}) // keep the floe channel open
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
	buffered, _ := settledPending(conn, 5*time.Second)
	if buffered != len(cands) {
		t.Fatalf("%d of the answerer's %d candidates buffered before its answer", buffered, len(cands))
	}
	sendSignal(t, s, "answer", answer.SDP)
	if _, err := waitSetup(t, done, time.Now(), 20*time.Second); err != nil {
		t.Fatalf("setup: %v", err)
	}
	return conn, s, buffered
}

// sendCandidate relays one candidate from the answerer through the fake server.
func sendCandidate(t *testing.T, s *setupWS, c webrtc.ICECandidateInit) {
	t.Helper()
	if err := s.ws.WriteJSON(map[string]any{"type": "signal", "sender": "visitor", "signal": map[string]any{"candidate": c}}); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// TestSignaledCandidatesAreCappedForTheConnection: after the answer, a
// connected peer that keeps sending distinct candidates gets exactly 256 into
// pion over the connection's life, the ones buffered before the answer
// included, and pion never holds more on the way; before, every one was
// handed to pion and kept.
//
// The count must not depend on the runner's speed (review A R6): the engine's
// two hand-offs ahead of addRemoteCandidate (the signaling client's and the
// dispatcher's channels) drop a frame when full, so the candidates go in
// batches smaller than either, each sent only once both channels have
// drained. No frame can be dropped however slow the runner is.
func TestSignaledCandidatesAreCappedForTheConnection(t *testing.T) {
	conn, s, buffered := connectedSender(t)
	const sent, batch = 1000, 16
	drained := func() {
		for deadline := time.Now().Add(10 * time.Second); len(conn.sc.Signal) > 0 || len(conn.candidates) > 0; {
			if time.Now().After(deadline) {
				t.Fatal("the engine's hand-offs did not drain within 10 s")
			}
			time.Sleep(time.Millisecond)
		}
	}
	most := 0
	for i := 0; i < sent; i++ {
		sendCandidate(t, s, hostCandidate(i)) // 192.0.2.x (TEST-NET-1), distinct ports
		if i%batch == batch-1 || i == sent-1 {
			drained()
			if n := len(signaledRemotes(conn.pc)); n > most {
				most = n
			}
		}
	}
	got := settledRemotes(conn.pc, 15*time.Second)
	if len(got) > most {
		most = len(got)
	}
	after := 0
	for _, r := range got {
		if strings.HasPrefix(r, "192.0.2.") {
			after++
		}
	}
	t.Logf("%d buffered before the answer, %d sent after it: pion holds %d signaled remote candidates, %d of them sent after, at most %d on the way",
		buffered, sent, len(got), after, most)
	if most > remoteCountBound {
		t.Fatalf("pion held %d signaled remote candidates on the way, want never more than %d over the connection's life", most, remoteCountBound)
	}
	if len(got) != remoteCountBound {
		t.Fatalf("pion holds %d signaled remote candidates once settled, want exactly %d", len(got), remoteCountBound)
	}
}

// TestOversizeCandidateDroppedBeforeTheAnswer: a candidate whose three strings
// pass 1 KiB is never buffered, whichever string carries the bytes, while one
// of exactly 1 KiB is.
func TestOversizeCandidateDroppedBeforeTheAnswer(t *testing.T) {
	conn := &Connection{}
	conn.addRemoteCandidate(sizedCandidate(1, candidateByteCap+1))
	ufrag := strings.Repeat("u", candidateByteCap)
	conn.addRemoteCandidate(webrtc.ICECandidateInit{Candidate: "candidate:1 1 udp 1 198.51.100.3 9 typ host", UsernameFragment: &ufrag})
	mid := strings.Repeat("m", candidateByteCap)
	conn.addRemoteCandidate(webrtc.ICECandidateInit{Candidate: "candidate:1 1 udp 1 198.51.100.4 9 typ host", SDPMid: &mid})
	if n, held := pendingNow(conn); n != 0 {
		t.Fatalf("%d candidates of over %d bytes buffered (%d bytes), want none", n, candidateByteCap, held)
	}
	conn.addRemoteCandidate(sizedCandidate(2, candidateByteCap))
	if n, held := pendingNow(conn); n != 1 || held != candidateByteCap {
		t.Fatalf("a candidate of exactly %d bytes: %d buffered, %d bytes; want 1 of %d", candidateByteCap, n, held, candidateByteCap)
	}
}

// TestOversizeCandidateDroppedAfterTheAnswer: after the answer, a candidate
// whose three strings pass 1 KiB never reaches pion, while one of exactly
// 1 KiB sent after it does.
func TestOversizeCandidateDroppedAfterTheAnswer(t *testing.T) {
	conn, s, _ := connectedSender(t)
	big, fits := sizedCandidate(1, candidateByteCap+1), sizedCandidate(2, candidateByteCap)
	sendCandidate(t, s, big)
	sendCandidate(t, s, fits)
	const bigAt, fitsAt = "198.51.100.1:40001", "198.51.100.2:40002"
	has := func(list []string, want string) bool {
		for _, r := range list {
			if r == want {
				return true
			}
		}
		return false
	}
	deadline := time.Now().Add(5 * time.Second)
	for !has(signaledRemotes(conn.pc), fitsAt) {
		if time.Now().After(deadline) {
			t.Fatalf("the candidate of exactly %d bytes never reached pion", candidateByteCap)
		}
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(500 * time.Millisecond) // the larger one was sent first; give it time to land if it is taken
	if has(signaledRemotes(conn.pc), bigAt) {
		t.Fatalf("pion holds the candidate of %d bytes, want it dropped before pion", candidateByteCap+1)
	}
}
