package peer

// F2-CPQA-01, review A R1: candidates a peer writes into its SDP as
// a=candidate lines. pion adds every one of them itself, inside
// SetRemoteDescription, so they share the bounds of the trickled ones only if
// setRemoteDesc holds them to those bounds first. Both roles take this path:
// the answer for SetupAsSender, the offer for SetupAsReceiver.

import (
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// quietPeer is a pion peer that gathers no candidate at all (every address
// filtered out, no ICE server), so it pairs and checks nothing: a remote
// candidate handed to it is only kept, which pion's stats then count, and no
// test here sends a packet toward any address it names.
func quietPeer(t *testing.T) *webrtc.PeerConnection {
	t.Helper()
	se := webrtc.SettingEngine{}
	se.SetIPFilter(func(net.IP) bool { return false })
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(se)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("quiet peer: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	return pc
}

// quietPair returns a Connection around a quiet peer and the remote
// description that peer takes next: with asOfferer, the Connection has made
// the offer (as SetupAsSender) and gets an answer; otherwise it gets an offer
// (as SetupAsReceiver). Neither description carries a candidate.
func quietPair(t *testing.T, asOfferer bool) (*Connection, webrtc.SessionDescription) {
	t.Helper()
	offerer := quietPeer(t)
	if _, err := offerer.CreateDataChannel("floe", nil); err != nil {
		t.Fatalf("channel: %v", err)
	}
	offer, err := offerer.CreateOffer(nil)
	if err != nil {
		t.Fatalf("offer: %v", err)
	}
	if err := offerer.SetLocalDescription(offer); err != nil {
		t.Fatalf("offerer local description: %v", err)
	}
	if !asOfferer {
		return &Connection{pc: quietPeer(t)}, offer
	}
	answerer := quietPeer(t)
	if err := answerer.SetRemoteDescription(offer); err != nil {
		t.Fatalf("answerer remote description: %v", err)
	}
	answer, err := answerer.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("answer: %v", err)
	}
	if err := answerer.SetLocalDescription(answer); err != nil {
		t.Fatalf("answerer local description: %v", err)
	}
	return &Connection{pc: offerer}, answer
}

// withCandidateLines appends the lines, then a=end-of-candidates, to the
// description's last (and only) media section.
func withCandidateLines(sdp string, lines []string) string {
	var b strings.Builder
	b.WriteString(sdp)
	for _, l := range lines {
		b.WriteString(l + "\r\n")
	}
	b.WriteString("a=end-of-candidates\r\n")
	return b.String()
}

// candidateLine is an a=candidate line at 198.51.100.i (TEST-NET-2) whose value,
// the line without "a=", is exactly valueLen bytes.
func candidateLine(i, valueLen int) string {
	return "a=" + sizedCandidate(i, valueLen+1).Candidate // sizedCandidate counts its one-byte SDPMid
}

// TestSDPCandidatesShareTheCap: a remote description that carries far more
// a=candidate lines than the cap leaves pion holding exactly 256 signaled
// candidates, counted together with the ones buffered before it and the ones
// trickled after it; the rest of the description reaches pion intact. Also
// with every candidate line led by carriage returns (review A-2 R9): pion's
// SDP lexer skips any \r or \n before a line's type letter, so such a line is
// still a candidate to pion and must be one to the filter too.
func TestSDPCandidatesShareTheCap(t *testing.T) {
	for _, tc := range []struct {
		asOfferer bool
		prefix    string
	}{{true, ""}, {false, ""}, {true, "\r"}, {false, "\r"}, {true, "\r\r"}, {false, "\r\r"}} {
		asOfferer := tc.asOfferer
		name := "in the answer (SetupAsSender)"
		if !asOfferer {
			name = "in the offer (SetupAsReceiver)"
		}
		name += fmt.Sprintf(", lines led by %q", tc.prefix)
		t.Run(name, func(t *testing.T) {
			conn, desc := quietPair(t, asOfferer)
			const buffered, inSDP = 10, 2000
			for i := 1; i <= buffered; i++ {
				conn.addRemoteCandidate(sizedCandidate(i, 200))
			}
			lines := make([]string, inSDP)
			for i := range lines {
				lines[i] = tc.prefix + "a=" + hostCandidate(i).Candidate // 192.0.2.x (TEST-NET-1), distinct ports
			}
			desc.SDP = withCandidateLines(desc.SDP, lines)
			if err := conn.setRemoteDesc(desc); err != nil {
				t.Fatalf("setRemoteDesc: %v", err)
			}
			conn.addRemoteCandidate(hostCandidate(inSDP + 3000)) // trickled after the description
			got := settledRemotes(conn.pc, 15*time.Second)
			t.Logf("%d buffered, %d in the SDP, 1 after: pion holds %d signaled remote candidates", buffered, inSDP, len(got))
			if len(got) != remoteCountBound {
				t.Fatalf("pion holds %d signaled remote candidates, want exactly %d, buffered, SDP and trickled together", len(got), remoteCountBound)
			}
			held := conn.pc.RemoteDescription().SDP
			for _, want := range []string{"a=ice-ufrag:", "a=fingerprint:", "a=sctp-port:", "a=end-of-candidates"} {
				if !strings.Contains(held, want) {
					t.Fatalf("the description pion holds lost its %q line", want)
				}
			}
		})
	}
}

// TestOversizeSDPCandidateDropped: an a=candidate line whose value passes
// 1 KiB never reaches pion, also when led by a carriage return (review A-2
// R9), while one of exactly 1 KiB does.
func TestOversizeSDPCandidateDropped(t *testing.T) {
	conn, desc := quietPair(t, true)
	desc.SDP = withCandidateLines(desc.SDP, []string{
		candidateLine(1, candidateByteCap+1),
		candidateLine(2, candidateByteCap),
		"\r" + candidateLine(3, candidateByteCap+1),
	})
	if err := conn.setRemoteDesc(desc); err != nil {
		t.Fatalf("setRemoteDesc: %v", err)
	}
	const bigAt, fitsAt, bigLedAt = "198.51.100.1:40001", "198.51.100.2:40002", "198.51.100.3:40003"
	got := settledRemotes(conn.pc, 10*time.Second)
	t.Logf("pion holds %q", got)
	has := map[string]bool{}
	for _, r := range got {
		has[r] = true
	}
	if !has[fitsAt] {
		t.Fatalf("the SDP candidate of exactly %d bytes never reached pion", candidateByteCap)
	}
	if has[bigAt] {
		t.Fatalf("pion holds the SDP candidate of %d bytes, want it dropped before pion", candidateByteCap+1)
	}
	if has[bigLedAt] {
		t.Fatalf("pion holds the SDP candidate of %d bytes led by a carriage return, want it dropped before pion", candidateByteCap+1)
	}
}

// TestSDPCandidatesStillConnect: a peer that trickles nothing and puts all its
// candidates in its answer (pion's own complete description, with
// a=end-of-candidates) still connects to a host that sees no other candidate:
// the host's own never reach the answerer, so nothing else could pair them.
func TestSDPCandidatesStillConnect(t *testing.T) {
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
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		t.Fatalf("answerer local description: %v", err)
	}
	select {
	case <-gathered:
	case <-time.After(10 * time.Second):
		t.Fatal("the answerer never finished gathering")
	}
	full := pc.LocalDescription().SDP
	lines := strings.Count(full, "\na=candidate:")
	if lines == 0 {
		t.Skip("no IPv4 host candidate on this machine")
	}
	sendSignal(t, s, "answer", full)
	if _, err := waitSetup(t, done, time.Now(), 20*time.Second); err != nil {
		t.Fatalf("setup from %d SDP candidates: %v", lines, err)
	}
	// pion writes each of its candidates twice in its own description (for
	// components 1 and 2) and keeps one of each address, so compare distinct
	// addresses.
	distinct := map[string]bool{}
	for _, l := range strings.Split(full, "\r\n") {
		if f := strings.Fields(l); strings.HasPrefix(l, "a=candidate:") && len(f) >= 6 {
			distinct[f[4]+":"+f[5]] = true
		}
	}
	if got := signaledRemotes(conn.pc); len(got) != len(distinct) {
		t.Fatalf("pion holds %d signaled remote candidates, want the answer's %d distinct ones", len(got), len(distinct))
	}
	t.Logf("connected from the %d candidate lines (%d distinct) in the answer alone", lines, len(distinct))
}
