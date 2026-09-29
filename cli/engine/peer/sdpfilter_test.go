package peer

// filterSDPCandidates (review A R1) must leave a real description alone: only
// a=candidate lines past the budget or past maxCandidateBytes go, and every
// other byte, a=end-of-candidates and the line endings included, stays.

import (
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// Chrome's own data-channel descriptions, captured from headless Chrome 151 on
// 2026-09-29 (no ICE server, Chrome's default mDNS host names, so no local
// address): its trickle answer as simple-peer sends it, and a complete offer.
const (
	chromeAnswerTrickle = "v=0\r\no=- 2219507394900396455 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=extmap-allow-mixed\r\na=msid-semantic: WMS\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:I43J\r\na=ice-pwd:q+qZLkN58kjA0o42NMokRwBp\r\na=ice-options:trickle\r\na=fingerprint:sha-256 AE:31:E0:A2:8C:51:76:80:C6:8E:96:79:79:39:8E:D8:DF:0F:17:13:FE:9E:44:C5:90:63:E1:00:97:41:2B:65\r\na=setup:active\r\na=mid:0\r\na=sctp-port:5000\r\na=max-message-size:262144\r\n"
	chromeOfferComplete = "v=0\r\no=- 368858169020339007 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=extmap-allow-mixed\r\na=msid-semantic: WMS\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=candidate:529478310 1 udp 2113937151 4887f10d-c4e5-45e1-86ee-5d9a05f256f1.local 62551 typ host generation 0 network-cost 999\r\na=ice-ufrag:FMYv\r\na=ice-pwd:DTAXQ4iQgi25BsQ2AY1EzMJw\r\na=ice-options:trickle\r\na=fingerprint:sha-256 18:F7:40:C0:9D:90:4A:74:B2:18:3C:78:5B:9B:57:5E:74:4D:BF:90:28:8C:5D:49:A2:F6:DD:DB:D2:AC:5D:A8\r\na=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\na=max-message-size:262144\r\n"
)

// firefoxShapedAnswer is written by hand in the shape Firefox gives a complete
// data-channel answer (upper-case transports, mDNS host names, TCP active,
// srflx and relay lines with documentation addresses, a=end-of-candidates),
// not captured: no Firefox is installed on this machine.
const firefoxShapedAnswer = "v=0\r\no=mozilla...THIS_IS_SDPARTA-99.0 6718393584216498224 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\na=sendrecv\r\na=fingerprint:sha-256 0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9:0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9\r\na=group:BUNDLE 0\r\na=ice-options:trickle\r\na=msid-semantic:WMS *\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=candidate:0 1 UDP 2122252543 7b4a1f2e-3c5d-4e6f-8a9b-0c1d2e3f4a5b.local 50613 typ host\r\na=candidate:2 1 TCP 2105524479 7b4a1f2e-3c5d-4e6f-8a9b-0c1d2e3f4a5b.local 9 typ host tcptype active\r\na=candidate:1 1 UDP 1686052863 203.0.113.9 50613 typ srflx raddr 0.0.0.0 rport 0\r\na=candidate:3 1 UDP 92217343 198.51.100.30 61234 typ relay raddr 203.0.113.9 rport 50613\r\na=sendrecv\r\na=end-of-candidates\r\na=ice-pwd:4b1f0c9e8d7a6b5c4d3e2f1a0b9c8d7e\r\na=ice-ufrag:5a6b7c8d\r\na=mid:0\r\na=setup:active\r\na=sctp-port:5000\r\na=max-message-size:1073741823\r\n"

// pionComplete is pion's own complete offer (the engine's shape once gathering
// is done): its candidates and a=end-of-candidates in the description.
func pionComplete(t *testing.T) string {
	t.Helper()
	se := webrtc.SettingEngine{}
	se.SetIPFilter(keepICEIP)
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(se)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("peer: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	if _, err := pc.CreateDataChannel("floe", nil); err != nil {
		t.Fatalf("channel: %v", err)
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("offer: %v", err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("local description: %v", err)
	}
	select {
	case <-gathered:
	case <-time.After(10 * time.Second):
		t.Fatal("never finished gathering")
	}
	return pc.LocalDescription().SDP
}

func TestFilterSDPCandidatesKeepsRealDescriptions(t *testing.T) {
	shapes := map[string]string{
		"Chrome trickle answer":  chromeAnswerTrickle,
		"Chrome complete offer":  chromeOfferComplete,
		"Firefox-shaped answer":  firefoxShapedAnswer,
		"pion complete offer":    pionComplete(t),
		"Chrome offer, LF lines": strings.ReplaceAll(chromeOfferComplete, "\r\n", "\n"),
	}
	for name, sdp := range shapes {
		want := strings.Count("\n"+sdp, "\na=candidate:")
		out, kept := filterSDPCandidates(sdp, remoteCountBound)
		if out != sdp {
			t.Errorf("%s: the description changed:\n%q\nbecame\n%q", name, sdp, out)
		}
		if kept != want {
			t.Errorf("%s: kept %d candidate lines, want its %d", name, kept, want)
		}
	}
}

func TestFilterSDPCandidatesHoldsTheBounds(t *testing.T) {
	head := "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=ice-ufrag:abcd\r\n"
	fits, big := candidateLine(2, candidateByteCap), candidateLine(1, candidateByteCap+1)
	sdp := head + "a=candidate:1 1 udp 1 192.0.2.1 1 typ host\r\n" + big + "\r\n" + fits + "\r\na=candidate\r\n" +
		"a=candidate:2 1 udp 1 192.0.2.2 2 typ host\r\na=end-of-candidates\r\na=mid:0\r\n"

	out, kept := filterSDPCandidates(sdp, 3)
	want := head + "a=candidate:1 1 udp 1 192.0.2.1 1 typ host\r\n" + fits + "\r\na=candidate\r\n" +
		"a=end-of-candidates\r\na=mid:0\r\n"
	if out != want || kept != 3 {
		t.Fatalf("room 3: kept %d, got\n%q\nwant\n%q", kept, out, want)
	}

	out, kept = filterSDPCandidates(sdp, 0)
	if want := head + "a=end-of-candidates\r\na=mid:0\r\n"; out != want || kept != 0 {
		t.Fatalf("room 0: kept %d, got\n%q\nwant\n%q", kept, out, want)
	}
}
