// Package peer manages the WebRTC peer connection using the pion library.
// It handles ICE negotiation, SDP exchange, and data channel setup.
package peer

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/pion/webrtc/v4"
)

// Connection timeouts guard the WebRTC connect phase so a peer that never
// completes ICE/DTLS (restrictive NAT, no working relay, vanished peer) fails
// fast with a clear error instead of hanging forever. The file transfer itself
// carries its own timeouts (see the transfer package).
const (
	signalWaitTimeout = 30 * time.Second // waiting for the peer's SDP offer/answer
	connectTimeout    = 30 * time.Second // waiting for ICE/DTLS + the data channel to open
	connectGrace      = 10 * time.Second // extra grace for the data channel after "connected"
)

// signalPayload is the JSON structure for WebRTC signals sent over the
// signaling channel. It can be either an SDP (offer/answer) or an ICE candidate.
type signalPayload struct {
	// SDP offer or answer
	Type string `json:"type,omitempty"` // "offer" or "answer"
	SDP  string `json:"sdp,omitempty"`

	// ICE candidate from the remote peer
	Candidate *webrtc.ICECandidateInit `json:"candidate,omitempty"`
}

// Connection wraps a pion RTCPeerConnection with signaling and ICE buffering.
type Connection struct {
	pc *webrtc.PeerConnection
	sc *signaling.Client

	// Typed signal channels — the dispatcher goroutine routes from sc.Signal
	offers     chan webrtc.SessionDescription
	answers    chan webrtc.SessionDescription
	candidates chan webrtc.ICECandidateInit

	// ICE candidates received before the remote description was set are buffered
	mu                sync.Mutex
	remoteDescSet     bool
	pendingCandidates []webrtc.ICECandidateInit

	// connected is sent once when the PeerConnection reaches "connected" state
	connected chan error
}

// Option configures the underlying WebRTC connection.
type Option func(*webrtc.Configuration)

// WithRelayOnly forces all traffic through the TURN relay (ICE "relay" transport
// policy) so the peer sees only the relay's IP, not this device's. Requires TURN
// to be available; a direct connection is not attempted.
func WithRelayOnly() Option {
	return func(c *webrtc.Configuration) {
		c.ICETransportPolicy = webrtc.ICETransportPolicyRelay
	}
}

// New creates a pion RTCPeerConnection with the given ICE servers and starts
// the signal dispatcher. Call SetupAsSender or SetupAsReceiver next.
func New(iceServers []webrtc.ICEServer, sc *signaling.Client, opts ...Option) (*Connection, error) {
	config := webrtc.Configuration{ICEServers: iceServers}
	for _, o := range opts {
		o(&config)
	}

	// Configure SCTP to accept large messages from browsers.
	// Chrome sends data channel chunks of 160–256 KB. pion's defaults may
	// silently drop messages exceeding its internal limits, causing
	// browser-to-CLI transfers to stall after the small metadata arrives.
	se := webrtc.SettingEngine{}
	se.SetSCTPMaxReceiveBufferSize(16 * 1024 * 1024) // 16 MB total receive buffer
	api := webrtc.NewAPI(webrtc.WithSettingEngine(se))

	pc, err := api.NewPeerConnection(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create peer connection: %w", err)
	}

	conn := &Connection{
		pc:         pc,
		sc:         sc,
		offers:     make(chan webrtc.SessionDescription, 1),
		answers:    make(chan webrtc.SessionDescription, 1),
		candidates: make(chan webrtc.ICECandidateInit, 64),
		connected:  make(chan error, 1),
	}

	// When pion discovers a local ICE candidate, forward it to the remote peer.
	// This is "trickle ICE" — candidates are sent as they are gathered.
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return // nil signals that gathering is complete
		}
		init := c.ToJSON()
		sc.SendSignal(map[string]interface{}{"candidate": init})
	})

	// Track when the connection becomes live (or fails).
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		switch s {
		case webrtc.PeerConnectionStateConnected:
			select {
			case conn.connected <- nil:
			default:
			}
		case webrtc.PeerConnectionStateFailed,
			webrtc.PeerConnectionStateDisconnected,
			webrtc.PeerConnectionStateClosed:
			select {
			case conn.connected <- fmt.Errorf("connection failed (state: %s)", s):
			default:
			}
		}
	})

	// The dispatcher goroutine reads raw signals from the signaling channel
	// and routes them to the typed offer/answer/candidate channels.
	go conn.dispatchSignals()

	// The candidate goroutine continuously adds remote ICE candidates,
	// buffering them if the remote description is not yet set.
	go conn.handleCandidates()

	return conn, nil
}

// SetupAsSender is called by `floe send`.
// It creates a data channel, sends an SDP offer, waits for the answer,
// and returns the open data channel ready for file transfer.
func (conn *Connection) SetupAsSender() (*webrtc.DataChannel, error) {
	// The sender (initiator) creates the data channel BEFORE the offer.
	// The data channel label "floe" identifies it to the remote peer.
	dc, err := conn.pc.CreateDataChannel("floe", nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create data channel: %w", err)
	}

	// Create the SDP offer describing our capabilities
	offer, err := conn.pc.CreateOffer(nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create offer: %w", err)
	}

	if err := conn.pc.SetLocalDescription(offer); err != nil {
		return nil, fmt.Errorf("failed to set local description: %w", err)
	}

	// When the CLI is the sender, the browser reads its OWN answer SDP (not
	// our offer) to determine max-message-size.  No patching needed here.

	// Send the offer to the receiver via the signaling server
	if err := conn.sc.SendSignal(signalPayload{Type: "offer", SDP: offer.SDP}); err != nil {
		return nil, fmt.Errorf("failed to send offer: %w", err)
	}

	// Wait for the receiver's SDP answer (bounded so a vanished peer fails fast).
	var answer webrtc.SessionDescription
	select {
	case a, ok := <-conn.answers:
		if !ok {
			return nil, fmt.Errorf("signaling closed before answer was received")
		}
		answer = a
	case <-time.After(signalWaitTimeout):
		return nil, fmt.Errorf("timed out waiting for the peer to answer")
	}

	if err := conn.setRemoteDesc(answer); err != nil {
		return nil, err
	}

	// Wait for the data channel to open (ICE + DTLS must complete first). Fail
	// fast if the connection reports failure/closure or never establishes,
	// instead of blocking forever.
	dcOpen := make(chan struct{})
	dc.OnOpen(func() { close(dcOpen) })
	select {
	case <-dcOpen:
		return dc, nil
	case err := <-conn.connected:
		if err != nil {
			return nil, err
		}
		// Reached "connected"; give the data channel a brief grace to open.
		select {
		case <-dcOpen:
			return dc, nil
		case <-time.After(connectGrace):
			return nil, fmt.Errorf("connected but the data channel did not open")
		}
	case <-time.After(connectTimeout):
		return nil, fmt.Errorf("timed out establishing a connection")
	}
}

// SetupAsReceiver is called by `floe receive`.
// It waits for the sender's SDP offer, sends an answer,
// and returns the open data channel ready for file transfer.
func (conn *Connection) SetupAsReceiver() (*webrtc.DataChannel, error) {
	// The receiver waits for a data channel from the sender.
	dcChan := make(chan *webrtc.DataChannel, 1)
	conn.pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		dc.OnOpen(func() {
			dcChan <- dc
		})
	})

	// Wait for the sender's SDP offer (bounded so a vanished peer fails fast).
	var offer webrtc.SessionDescription
	select {
	case o, ok := <-conn.offers:
		if !ok {
			return nil, fmt.Errorf("signaling closed before offer was received")
		}
		offer = o
	case <-time.After(signalWaitTimeout):
		return nil, fmt.Errorf("timed out waiting for the peer's offer")
	}

	if err := conn.setRemoteDesc(offer); err != nil {
		return nil, err
	}

	// Create our SDP answer
	answer, err := conn.pc.CreateAnswer(nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create answer: %w", err)
	}

	if err := conn.pc.SetLocalDescription(answer); err != nil {
		return nil, fmt.Errorf("failed to set local description: %w", err)
	}

	// pion v3.3.6 OMITS a=max-message-size from SDP entirely.
	// RFC 8841 says absent = default 65536 (64 KB). Chrome enforces this,
	// causing "Failure to send data" for chunks > 64 KB (browser uses 160 KB).
	// Inject a large value into the SDP we SEND to the browser (not what pion
	// uses internally — SetLocalDescription already consumed the original).
	patchedSDP := patchMaxMessageSize(answer.SDP)

	// Send the answer to the sender
	if err := conn.sc.SendSignal(signalPayload{Type: "answer", SDP: patchedSDP}); err != nil {
		return nil, fmt.Errorf("failed to send answer: %w", err)
	}

	// Wait for the data channel to arrive from the sender. Fail fast if the
	// connection reports failure/closure or never establishes.
	select {
	case dc := <-dcChan:
		return dc, nil
	case err := <-conn.connected:
		if err != nil {
			return nil, err
		}
		select {
		case dc := <-dcChan:
			return dc, nil
		case <-time.After(connectGrace):
			return nil, fmt.Errorf("connected but the data channel did not open")
		}
	case <-time.After(connectTimeout):
		return nil, fmt.Errorf("timed out establishing a connection")
	}
}

// WaitConnected blocks until the peer connection reaches "connected" state or fails.
func (conn *Connection) WaitConnected() error {
	return <-conn.connected
}

// Close tears down the peer connection.
func (conn *Connection) Close() {
	conn.pc.Close()
}

// Fingerprints returns the local and remote DTLS certificate fingerprints from
// the negotiated SDPs (e.g. "sha-256 AB:CD:..."). Call after the data channel is
// open, when both descriptions are set. These feed the connection verification
// code (see engine/verify) so peers can detect a man-in-the-middle.
func (conn *Connection) Fingerprints() (local, remote string, err error) {
	ld := conn.pc.LocalDescription()
	rd := conn.pc.RemoteDescription()
	if ld == nil || rd == nil {
		return "", "", fmt.Errorf("connection not established")
	}
	local = extractFingerprint(ld.SDP)
	remote = extractFingerprint(rd.SDP)
	if local == "" || remote == "" {
		return "", "", fmt.Errorf("no DTLS fingerprint in SDP")
	}
	return local, remote, nil
}

// extractFingerprint returns the value of the first "a=fingerprint:" attribute
// in an SDP (e.g. "sha-256 AB:CD:..."), or "" if absent.
func extractFingerprint(sdp string) string {
	for _, line := range strings.Split(sdp, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "a=fingerprint:") {
			return strings.TrimSpace(line[len("a=fingerprint:"):])
		}
	}
	return ""
}

// setRemoteDesc sets the remote SDP and flushes any buffered ICE candidates.
func (conn *Connection) setRemoteDesc(desc webrtc.SessionDescription) error {
	if err := conn.pc.SetRemoteDescription(desc); err != nil {
		return fmt.Errorf("failed to set remote description: %w", err)
	}

	conn.mu.Lock()
	conn.remoteDescSet = true
	pending := conn.pendingCandidates
	conn.pendingCandidates = nil
	conn.mu.Unlock()

	for _, c := range pending {
		conn.pc.AddICECandidate(c)
	}
	return nil
}

// addRemoteCandidate adds a remote ICE candidate, or buffers it if the remote
// description has not been set yet.
func (conn *Connection) addRemoteCandidate(c webrtc.ICECandidateInit) {
	conn.mu.Lock()
	defer conn.mu.Unlock()

	if conn.remoteDescSet {
		conn.pc.AddICECandidate(c)
	} else {
		conn.pendingCandidates = append(conn.pendingCandidates, c)
	}
}

// dispatchSignals runs in a goroutine. It reads raw JSON from the signaling
// channel and routes each message to the offers, answers, or candidates channel.
func (conn *Connection) dispatchSignals() {
	for rawSignal := range conn.sc.Signal {
		var payload signalPayload
		if err := json.Unmarshal(rawSignal, &payload); err != nil {
			continue
		}

		if payload.Candidate != nil {
			select {
			case conn.candidates <- *payload.Candidate:
			default:
			}
		} else if payload.Type == "offer" {
			select {
			case conn.offers <- webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: payload.SDP}:
			default:
			}
		} else if payload.Type == "answer" {
			select {
			case conn.answers <- webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: payload.SDP}:
			default:
			}
		}
	}
}

// handleCandidates runs in a goroutine. It drains the candidates channel and
// adds each remote ICE candidate (or buffers it if remote desc not yet set).
func (conn *Connection) handleCandidates() {
	for c := range conn.candidates {
		conn.addRemoteCandidate(c)
	}
}

// patchMaxMessageSize injects a=max-message-size into the SDP.
//
// pion/webrtc v3.3.6 does NOT include a=max-message-size in the SDP it
// generates. Per RFC 8841 §5, when the attribute is absent the remote peer
// MUST assume a default of 65536 bytes. Chrome enforces this default: any
// call to RTCDataChannel.send() with a payload larger than 65536 bytes throws
// "Failure to send data" (TypeError per the WebRTC spec §6.2 step 4).
//
// The browser's chunk size starts at 160 KB (chunkSizeRef = 160*1024), so
// every single chunk send fails. The fix is to explicitly advertise a large
// max-message-size (1 GB) after the a=sctp-port line that pion DOES emit.
// pion/sctp transparently handles SCTP-level fragmentation for large messages.
func patchMaxMessageSize(sdp string) string {
	const maxMsgAttr = "a=max-message-size:1073741824\r\n" // 1 GB

	// If the attribute already exists (future pion versions), replace it.
	if strings.Contains(sdp, "a=max-message-size:") {
		lines := strings.Split(sdp, "\r\n")
		for i, line := range lines {
			if strings.HasPrefix(line, "a=max-message-size:") {
				lines[i] = "a=max-message-size:1073741824"
			}
		}
		return strings.Join(lines, "\r\n")
	}

	// Otherwise inject it right after a=sctp-port:5000
	return strings.Replace(
		sdp,
		"a=sctp-port:5000\r\n",
		"a=sctp-port:5000\r\n"+maxMsgAttr,
		1,
	)
}
