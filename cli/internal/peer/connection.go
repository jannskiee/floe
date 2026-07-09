// Package peer manages the WebRTC peer connection using the pion library.
// It handles ICE negotiation, SDP exchange, and data channel setup.
package peer

import (
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"sync"

	"github.com/jannskiee/floe/cli/internal/signaling"
	"github.com/pion/webrtc/v4"
)

// keepICEIP reports whether an interface IP should be used for ICE candidate
// gathering. It drops link-local addresses (IPv4 169.254.0.0/16 and IPv6
// fe80::/10), which are handed out by virtual and VPN adapters (Hyper-V, WSL,
// VMware, Tailscale) and by APIPA auto-config when DHCP fails. Such addresses
// never form a working peer-to-peer path, but pion would otherwise gather a host
// candidate on each and spend 20-30s running connectivity checks that fail with
// "socket operation attempted to an unreachable host" before settling on the
// real interface (often falling back to the relay). Filtering by the link-local
// IP class is unambiguous and safe: it never removes a routable interface.
func keepICEIP(ip net.IP) bool {
	return !ip.IsLinkLocalUnicast()
}

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

// New creates a pion RTCPeerConnection with the given ICE servers and starts
// the signal dispatcher. Call SetupAsSender or SetupAsReceiver next.
func New(iceServers []webrtc.ICEServer, sc *signaling.Client) (*Connection, error) {
	config := webrtc.Configuration{ICEServers: iceServers}

	// Configure SCTP to accept large messages from browsers.
	// Chrome sends data channel chunks of 160–256 KB. pion's defaults may
	// silently drop messages exceeding its internal limits, causing
	// browser-to-CLI transfers to stall after the small metadata arrives.
	se := webrtc.SettingEngine{}
	se.SetSCTPMaxReceiveBufferSize(16 * 1024 * 1024) // 16 MB total receive buffer
	// Skip link-local interfaces when gathering ICE candidates so virtual/VPN
	// adapters (Hyper-V, WSL, Tailscale, APIPA) don't stall connection setup.
	se.SetIPFilter(keepICEIP)
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

	// Wait for the receiver's SDP answer
	answer, ok := <-conn.answers
	if !ok {
		return nil, fmt.Errorf("signaling closed before answer was received")
	}

	if err := conn.setRemoteDesc(answer); err != nil {
		return nil, err
	}

	// Wait for the data channel to open (ICE + DTLS must complete first)
	dcOpen := make(chan struct{})
	dc.OnOpen(func() { close(dcOpen) })
	<-dcOpen

	return dc, nil
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

	// Wait for the sender's SDP offer
	offer, ok := <-conn.offers
	if !ok {
		return nil, fmt.Errorf("signaling closed before offer was received")
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

	// Wait for the data channel to arrive from the sender
	dc := <-dcChan
	return dc, nil
}

// WaitConnected blocks until the peer connection reaches "connected" state or fails.
func (conn *Connection) WaitConnected() error {
	return <-conn.connected
}

// Close tears down the peer connection.
func (conn *Connection) Close() {
	conn.pc.Close()
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
