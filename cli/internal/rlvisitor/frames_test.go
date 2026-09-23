package main

// The hostile visitor's frame builders and flag parser, in process. The
// network wiring (run.go) is proved only by building; these pin every crafted
// shape and every flag a cell relies on.

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/jannskiee/floe/cli/engine/transfer"
)

// decodeMeta parses a metadata frame the way transfer.parseMetadata does,
// through the exported receiver path, so a shape these tests accept is one the
// real receiver will read.
func decodeMeta(t *testing.T, frame []byte) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal(frame, &m); err != nil {
		t.Fatalf("frame is not JSON: %v", err)
	}
	if m["type"] != "metadata" {
		t.Fatalf("frame type = %v, want metadata", m["type"])
	}
	for _, k := range []string{"id", "fileName", "fileSize", "index", "total", "totalBytes", "pv", "pvMin"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("frame is missing %q: %s", k, frame)
		}
	}
	if m["pv"] != float64(1) || m["pvMin"] != float64(1) {
		t.Fatalf("pv/pvMin = %v/%v, want 1/1", m["pv"], m["pvMin"])
	}
	return m
}

func TestHostileMetaFixtures(t *testing.T) {
	cases := map[string]struct {
		name string
		size float64
	}{
		"f2":  {name: strings.Repeat("d/", 40) + "deep.txt", size: 4},
		"f4b": {name: `C:\Windows\System32\evil.dll`, size: 4},
		"f5":  {name: "a.bin", size: float64(1<<53 - 1)},
		"f6":  {name: strings.Repeat("a", 704), size: 4},
	}
	for kind, want := range cases {
		frame, ok := hostileMetaFrame(kind)
		if !ok {
			t.Fatalf("hostileMetaFrame(%q) not built", kind)
		}
		m := decodeMeta(t, frame)
		if m["fileName"] != want.name {
			t.Errorf("%s fileName = %q, want %q", kind, m["fileName"], want.name)
		}
		if m["fileSize"] != want.size {
			t.Errorf("%s fileSize = %v, want %v", kind, m["fileSize"], want.size)
		}
		if m["index"] != float64(1) || m["total"] != float64(1) {
			t.Errorf("%s index/total = %v/%v, want 1/1", kind, m["index"], m["total"])
		}
	}
	if _, ok := hostileMetaFrame("f7"); ok {
		t.Error("hostileMetaFrame accepted an unknown fixture")
	}
}

// F2's path is 40 directory levels below the output, over the depth-32 limit;
// F6's single component is over the 240 UTF-16 unit path limit and under the
// 1000-byte control-frame cap.
func TestHostileMetaShapesCrossTheLimits(t *testing.T) {
	if got := strings.Count(f2Name(), "/"); got != 40 {
		t.Errorf("f2 has %d slashes, want 40", got)
	}
	if len(f6Name()) != 704 {
		t.Errorf("f6 name is %d bytes, want 704", len(f6Name()))
	}
	if len(f6Name()) >= 1000 {
		t.Errorf("f6 name %d bytes is over the control-frame cap", len(f6Name()))
	}
	if strings.ContainsAny(f6Name(), "/\\") {
		t.Error("f6 must be one component, no separator")
	}
}

// F5 announces exactly the largest byte count the receiver still reads as a
// number; one more is refused by byteCount.
func TestF5AnnouncesTheMaxSafeSize(t *testing.T) {
	if maxAnnouncedSize != 1<<53-1 {
		t.Fatalf("maxAnnouncedSize = %d", maxAnnouncedSize)
	}
	m := decodeMeta(t, mustFrame(t, "f5"))
	if m["fileSize"] != float64(maxAnnouncedSize) {
		t.Errorf("f5 fileSize = %v, want %d", m["fileSize"], maxAnnouncedSize)
	}
}

func mustFrame(t *testing.T, kind string) []byte {
	t.Helper()
	f, ok := hostileMetaFrame(kind)
	if !ok {
		t.Fatalf("no frame for %q", kind)
	}
	return f
}

// The skip-relay-gate visitor announces a file strictly over the 2 GiB relay
// cap, so the host refuses on a relay path before any byte moves.
func TestOversizeRelayMetaIsOverTheCap(t *testing.T) {
	m := decodeMeta(t, oversizeRelayMeta())
	if m["fileSize"] != float64(relaySizeLimit+1) {
		t.Errorf("oversize fileSize = %v, want %d", m["fileSize"], relaySizeLimit+1)
	}
	if relaySizeLimit != 2*1024*1024*1024 {
		t.Errorf("relaySizeLimit = %d, want 2 GiB", relaySizeLimit)
	}
}

// The hostile display name carries markup, a shell substitution and a bidi
// override, and no path separator (it is a name, not a path).
func TestHostileDisplayNameIsHostileButAName(t *testing.T) {
	n := hostileDisplayName()
	for _, sub := range []string{"<img", "$(calc)", "\u202e"} {
		if !strings.Contains(n, sub) {
			t.Errorf("hostile name missing %q", sub)
		}
	}
	if strings.ContainsAny(n, "/\\") {
		t.Error("hostile name must have no path separator")
	}
	m := decodeMeta(t, oneFileMeta(n, 4))
	if m["fileName"] != n {
		t.Error("the crafted name frame does not carry the hostile name")
	}
}

// The abort frame is an incompatible frame carrying the reason verbatim (the
// host must clean it, not the visitor).
func TestAbortFrameCarriesTheReason(t *testing.T) {
	reason := "$(calc)]]><img src=x>" + "\u202e"
	var m map[string]interface{}
	if err := json.Unmarshal(abortFrame(reason), &m); err != nil {
		t.Fatal(err)
	}
	if m["type"] != "incompatible" || m["reason"] != reason {
		t.Fatalf("abort frame = %v", m)
	}
	if m["pv"] != float64(1) || m["pvMin"] != float64(1) {
		t.Fatalf("abort frame pv/pvMin = %v/%v", m["pv"], m["pvMin"])
	}
}

func TestJunkFramesAreDistinctJSON(t *testing.T) {
	frames := junkFrames(2000)
	if len(frames) != 2000 {
		t.Fatalf("junkFrames(2000) = %d", len(frames))
	}
	for i, f := range []int{0, 999, 1999} {
		var m map[string]interface{}
		if err := json.Unmarshal(frames[f], &m); err != nil {
			t.Fatalf("junk frame %d not JSON: %v", i, err)
		}
		if m["type"] != "junk" || m["n"] != float64(f) {
			t.Errorf("junk frame %d = %v", f, m)
		}
	}
}

func TestBadSDPSignalIsAWellFormedEnvelopeWithBadSDP(t *testing.T) {
	sig := badSDPSignal()
	if sig["type"] != "answer" {
		t.Fatalf("bad-sdp type = %v, want answer", sig["type"])
	}
	sdp, _ := sig["sdp"].(string)
	// The SDP carries the hostile marker on its m= line (a shell substitution,
	// markup and a bidi override), so a host that leaked the parse error would
	// put it on screen.
	for _, sub := range []string{"$(calc)]]><img", "<img src=x>", "‮"} {
		if !strings.Contains(sdp, sub) {
			t.Errorf("bad-sdp SDP missing marker %q", sub)
		}
	}
}

// The visitor ack clock is VisitorAckTimeout plus its grace, so the host's own
// window ends first (M-04).
func TestVisitorAckClock(t *testing.T) {
	if visitorAckTimeout != transfer.VisitorAckTimeout+transfer.VisitorAckGrace {
		t.Fatalf("visitorAckTimeout = %v", visitorAckTimeout)
	}
	if visitorAckTimeout <= transfer.HostDecisionWindow {
		t.Fatalf("visitor clock %v must outlast the host window %v", visitorAckTimeout, transfer.HostDecisionWindow)
	}
}
