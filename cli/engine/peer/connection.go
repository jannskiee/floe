// Package peer manages the WebRTC peer connection using the pion library.
// It handles ICE negotiation, SDP exchange, and data channel setup.
package peer

import (
	"encoding/json"
	"fmt"
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

// signalWait is the offer and answer wait the two Setup calls use:
// signalWaitTimeout, as a variable only so a test can shrink it.
var signalWait = signalWaitTimeout

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

	// early is the data channel's message pump, wired the instant the channel
	// exists rather than when the transfer layer gets around to it. See attach.
	early *Early

	// done is closed exactly once by Close and is the only thing that stops
	// dispatchSignals and handleCandidates. Neither sc.Signal nor candidates
	// is ever closed: dispatchSignals SENDS into candidates, so closing that
	// channel would race a live send into a panic, and sc.Signal belongs to
	// the signaling client, whose Close shuts the socket without closing it.
	closeOnce sync.Once
	done      chan struct{}
}

// Early carries a data channel's incoming messages and its close signal.
//
// It exists because pion acknowledges a data channel and starts reading from it
// before the application has been told anything. datachannel.Server writes the
// DCEP ACK as soon as it reads the peer's OPEN, and webrtc's handleOpen then
// starts readLoop. A message that readLoop delivers while DataChannel.onMessage
// still holds a nil handler is DISCARDED, silently and permanently: SCTP has
// already acknowledged it, so it is never retransmitted and the sender has no
// idea it went nowhere.
//
// That window is microseconds wide and it is wide enough to lose a transfer.
// Measured on one machine with both peers local, the desktop app as sender
// completed 1 send in 25; adding a few hundred microseconds of delay anywhere in
// the receiver's SCTP path took it to 19 in 19. The symptom is both ends
// reporting a healthy connection and then nothing, which is exactly what the
// watchdog comment at the top of transfer/receiver.go describes as a captured CI
// failure. The margin scales with round-trip time, so two machines on a LAN or
// the internet almost always win it, which is why this shipped and mostly works.
//
// The fix is not to make the transfer layer faster. It is to have a handler
// installed before pion can possibly deliver, and to hand the resulting stream
// to whoever wants it.
type Early struct {
	// Msgs carries every message the data channel receives, in order.
	Msgs <-chan webrtc.DataChannelMessage
	// Closed is closed when the data channel closes. pion fires OnClose on
	// graceful closes only; see the note in transfer/sender.go.
	Closed <-chan struct{}
}

// earlyBuffer matches the buffer the transfer layer used when it owned this
// pump. It is backpressure, not a drop policy: a full buffer parks pion's read
// loop until the transfer layer catches up. EarlyBufferBytes bounds the same
// pump by bytes (framequeue.go).
const earlyBuffer = 256

// attach installs the ONLY OnMessage and OnClose handlers this data channel will
// ever have, and must be called synchronously at the moment the channel appears:
// immediately after CreateDataChannel for the sender, and inside OnDataChannel
// before OnOpen for the receiver. Both are before pion can start reading.
//
// Whoever consumes the channel must use conn.Early() rather than registering
// their own callbacks, because pion keeps one handler per event and a later
// registration silently replaces this one, reopening the window it closes.
func (conn *Connection) attach(dc *webrtc.DataChannel) {
	msgs := NewFrameQueue(earlyBuffer, EarlyBufferBytes, func(m webrtc.DataChannelMessage) int { return len(m.Data) })
	closed := make(chan struct{})
	var once sync.Once
	dc.OnClose(func() { once.Do(func() { close(closed) }) })
	// stop ends a wait for room at the channel's close or at this Connection's
	// Close, whichever comes first. The channel's close alone never did: pion
	// fires OnClose only once its read loop exits, and the read loop is the
	// goroutine waiting here, so a pump left full by a reader that had gone (a
	// receive that returned while the peer kept sending) parked the loop, and
	// every frame queued behind it, for the life of the process (F2-01).
	// Nothing closes msgs, so this never panics either.
	stop := make(chan struct{})
	go func() {
		select {
		case <-closed:
		case <-conn.done:
		}
		close(stop)
	}()
	dc.OnMessage(func(msg webrtc.DataChannelMessage) { msgs.Send(msg, stop) })
	conn.mu.Lock()
	conn.early = &Early{Msgs: msgs.C(), Closed: closed}
	conn.mu.Unlock()
}

// Early returns the message pump for the data channel returned by SetupAsSender
// or SetupAsReceiver. Pass it into transfer.SendOptions or transfer.ReceiveOptions;
// a transfer that registers its own OnMessage instead can lose the peer's first
// message. Nil before either Setup call has returned.
func (conn *Connection) Early() *Early {
	conn.mu.Lock()
	defer conn.mu.Unlock()
	return conn.early
}

// Option configures a Connection created by New.
type Option func(*settings)

// settings collects the optional knobs applied by Options before New builds the
// peer connection.
type settings struct {
	ifaceAllowlist []string // opt-in `--iface` filter (empty = all non-link-local)
	relayOnly      bool     // force TURN relay (hide-my-IP)
}

// WithRelayOnly forces all traffic through the TURN relay (ICE "relay" transport
// policy) so the peer sees only the relay's IP, not this device's. Requires TURN
// to be available; a direct connection is not attempted.
func WithRelayOnly() Option {
	return func(s *settings) { s.relayOnly = true }
}

// WithInterfaceAllowlist restricts ICE candidate gathering to network interfaces
// whose name contains one of the given substrings (case-insensitive). Empty or
// nil leaves the default (gather on all non-link-local interfaces).
func WithInterfaceAllowlist(names []string) Option {
	return func(s *settings) { s.ifaceAllowlist = names }
}

// New creates a pion RTCPeerConnection with the given ICE servers and starts
// the signal dispatcher. Call SetupAsSender or SetupAsReceiver next.
func New(iceServers []webrtc.ICEServer, sc *signaling.Client, opts ...Option) (*Connection, error) {
	var cfg settings
	for _, o := range opts {
		o(&cfg)
	}

	config := webrtc.Configuration{ICEServers: iceServers}
	if cfg.relayOnly {
		config.ICETransportPolicy = webrtc.ICETransportPolicyRelay
	}

	// Configure SCTP to accept large messages from browsers.
	// Chrome sends data channel chunks of 160–256 KB. pion's defaults may
	// silently drop messages exceeding its internal limits, causing
	// browser-to-CLI transfers to stall after the small metadata arrives.
	se := webrtc.SettingEngine{}
	se.SetSCTPMaxReceiveBufferSize(16 * 1024 * 1024) // 16 MB total receive buffer
	// Skip link-local interfaces when gathering ICE candidates so virtual/VPN
	// adapters (Hyper-V, WSL, Tailscale, APIPA) don't stall connection setup.
	se.SetIPFilter(keepICEIP)
	// Opt-in `--iface` override: pin ICE to specific interfaces by name.
	if f := makeInterfaceAllowFilter(cfg.ifaceAllowlist); f != nil {
		se.SetInterfaceFilter(f)
	}
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
		done:       make(chan struct{}),
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
// and returns the open data channel ready for file transfer. Every failure
// is a *SetupError naming its stage, with the text each site always had.
func (conn *Connection) SetupAsSender() (*webrtc.DataChannel, error) {
	// The sender (initiator) creates the data channel BEFORE the offer.
	// The data channel label "floe" identifies it to the remote peer.
	dc, err := conn.pc.CreateDataChannel("floe", nil)
	if err != nil {
		return nil, &SetupError{Stage: StageChannel, Err: fmt.Errorf("failed to create data channel: %w", err)}
	}
	// Before the offer even leaves, so the receiver's first ack cannot land in a
	// channel with no handler on it. See Early.
	conn.attach(dc)

	// Create the SDP offer describing our capabilities
	offer, err := conn.pc.CreateOffer(nil)
	if err != nil {
		return nil, &SetupError{Stage: StageOffer, Err: fmt.Errorf("failed to create offer: %w", err)}
	}

	if err := conn.pc.SetLocalDescription(offer); err != nil {
		return nil, &SetupError{Stage: StageOffer, Err: fmt.Errorf("failed to set local description: %w", err)}
	}

	// When the CLI is the sender, the browser reads its OWN answer SDP (not
	// our offer) to determine max-message-size.  No patching needed here.

	// Send the offer to the receiver via the signaling server
	if err := conn.sc.SendSignal(signalPayload{Type: "offer", SDP: offer.SDP}); err != nil {
		return nil, &SetupError{Stage: StageOffer, Err: fmt.Errorf("failed to send offer: %w", err)}
	}

	// Wait for the receiver's SDP answer (bounded so a vanished peer fails fast).
	var answer webrtc.SessionDescription
	select {
	case a, ok := <-conn.answers:
		if !ok {
			return nil, &SetupError{Stage: StageAnswer, Err: fmt.Errorf("signaling closed before answer was received")}
		}
		answer = a
	// The peer leaving, the server going away and a local Close end every
	// setup wait at once, instead of costing the full timeout and reading as
	// a failure to connect. PeerLeft is read here and in the three waits
	// below only: the join waits that also read it all finish before New.
	case <-conn.sc.PeerLeft:
		if conn.signalingLost() {
			return nil, &SetupError{Stage: StageSignalingLost, Err: ErrSignalingLost}
		}
		return nil, &SetupError{Stage: StagePeerLeft, Err: ErrPeerLeft}
	case <-conn.done:
		return nil, &SetupError{Stage: StageClosed, Err: ErrClosed}
	case <-time.After(signalWait):
		return nil, &SetupError{Stage: StageAnswer, Err: fmt.Errorf("timed out waiting for the peer to answer")}
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
			return nil, &SetupError{Stage: StageConnect, Err: err}
		}
		// Reached "connected"; give the data channel a brief grace to open.
		select {
		case <-dcOpen:
			return dc, nil
		case <-time.After(connectGrace):
			return nil, &SetupError{Stage: StageChannel, Err: fmt.Errorf("connected but the data channel did not open")}
		}
	case <-conn.sc.PeerLeft:
		if conn.signalingLost() {
			return nil, &SetupError{Stage: StageSignalingLost, Err: ErrSignalingLost}
		}
		return nil, &SetupError{Stage: StagePeerLeft, Err: ErrPeerLeft}
	case <-conn.done:
		return nil, &SetupError{Stage: StageClosed, Err: ErrClosed}
	case <-time.After(connectTimeout):
		return nil, &SetupError{Stage: StageConnect, Err: fmt.Errorf("timed out establishing a connection")}
	}
}

// SetupAsReceiver is called by `floe receive`.
// It waits for the sender's SDP offer, sends an answer,
// and returns the open data channel ready for file transfer. Every failure
// is a *SetupError naming its stage, with the text each site always had.
func (conn *Connection) SetupAsReceiver() (*webrtc.DataChannel, error) {
	// The receiver waits for a data channel from the sender.
	dcChan := make(chan *webrtc.DataChannel, 1)
	conn.pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		// attach FIRST, and in this callback rather than in OnOpen. pion runs
		// OnDataChannel synchronously before it starts the channel's read loop,
		// and it has already ACKed the channel by this point, so the sender may
		// be writing its first message right now. Registering in OnOpen, or
		// later in the transfer layer, is a race this loses on a fast path. See
		// Early for what losing it costs.
		conn.attach(dc)
		dc.OnOpen(func() {
			dcChan <- dc
		})
	})

	// Wait for the sender's SDP offer (bounded so a vanished peer fails fast).
	var offer webrtc.SessionDescription
	select {
	case o, ok := <-conn.offers:
		if !ok {
			return nil, &SetupError{Stage: StageOffer, Err: fmt.Errorf("signaling closed before offer was received")}
		}
		offer = o
	case <-conn.sc.PeerLeft:
		if conn.signalingLost() {
			return nil, &SetupError{Stage: StageSignalingLost, Err: ErrSignalingLost}
		}
		return nil, &SetupError{Stage: StagePeerLeft, Err: ErrPeerLeft}
	case <-conn.done:
		return nil, &SetupError{Stage: StageClosed, Err: ErrClosed}
	case <-time.After(signalWait):
		return nil, &SetupError{Stage: StageOffer, Err: fmt.Errorf("timed out waiting for the peer's offer")}
	}

	if err := conn.setRemoteDesc(offer); err != nil {
		return nil, err
	}

	// Create our SDP answer. pion builds it from the remote description, so
	// its error can quote the peer's SDP as the remote-description one can.
	answer, err := conn.pc.CreateAnswer(nil)
	if err != nil {
		return nil, &SetupError{Stage: StageAnswer, Err: fmt.Errorf("failed to create answer: %w", err)}
	}

	if err := conn.pc.SetLocalDescription(answer); err != nil {
		return nil, &SetupError{Stage: StageAnswer, Err: fmt.Errorf("failed to set local description: %w", err)}
	}

	// The answer goes out with a=max-message-size pinned to 1 GB. Chrome caps
	// RTCDataChannel.send() at whatever this SDP advertises, and at 64 KB when
	// the attribute is absent, which is where pion v3 left it; pion v4 emits it
	// with its own ceiling just under 1 GB, so today the rewrite is a pin, not a
	// rescue. It changes only what is sent: SetLocalDescription already consumed
	// the original. See patchMaxMessageSize.
	patchedSDP := patchMaxMessageSize(answer.SDP)

	// Send the answer to the sender
	if err := conn.sc.SendSignal(signalPayload{Type: "answer", SDP: patchedSDP}); err != nil {
		return nil, &SetupError{Stage: StageAnswer, Err: fmt.Errorf("failed to send answer: %w", err)}
	}

	// Wait for the data channel to arrive from the sender. Fail fast if the
	// connection reports failure/closure or never establishes.
	select {
	case dc := <-dcChan:
		return dc, nil
	case err := <-conn.connected:
		if err != nil {
			return nil, &SetupError{Stage: StageConnect, Err: err}
		}
		select {
		case dc := <-dcChan:
			return dc, nil
		case <-time.After(connectGrace):
			return nil, &SetupError{Stage: StageChannel, Err: fmt.Errorf("connected but the data channel did not open")}
		}
	case <-conn.sc.PeerLeft:
		if conn.signalingLost() {
			return nil, &SetupError{Stage: StageSignalingLost, Err: ErrSignalingLost}
		}
		return nil, &SetupError{Stage: StagePeerLeft, Err: ErrPeerLeft}
	case <-conn.done:
		return nil, &SetupError{Stage: StageClosed, Err: ErrClosed}
	case <-time.After(connectTimeout):
		return nil, &SetupError{Stage: StageConnect, Err: fmt.Errorf("timed out establishing a connection")}
	}
}

// signalingLost tells a PeerLeft push that came from the socket closing from
// one the server sent: the signaling client closes Down before it pushes
// PeerLeft on the way out of its read loop, so a closed Down here means the
// server is gone, not the peer. A client built without Connect has a nil
// Down, which reads as open.
func (conn *Connection) signalingLost() bool {
	select {
	case <-conn.sc.Down:
		return true
	default:
		return false
	}
}

// Close tears down the peer connection and releases the two goroutines New
// started. Idempotent: the CLI defers this once, but the desktop builds a
// fresh Connection per transfer, so a leak here is unbounded over a session.
func (conn *Connection) Close() {
	conn.closeOnce.Do(func() { close(conn.done) })
	conn.pc.Close()
}

// Fingerprints returns the local and remote DTLS certificate fingerprints from
// the negotiated SDPs (e.g. "sha-256 AB:CD:..."). Call after the data channel is
// open, when both descriptions are set. These feed the connection verification
// code (see engine/verify) so peers can detect a man-in-the-middle. Retained
// but unwired: no surface calls this today, and PAKE (DESKTOP.md 3b) is the
// intended consumer.
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

// ConnectionType reports the selected ICE path: "relay" when either side of the
// selected candidate pair is a TURN relay, "direct" otherwise. Only meaningful
// once the connection is established (call after SetupAsSender/SetupAsReceiver
// returns); before that it returns an error.
//
// pathTypeOf in engine/transfer is the same walk started from the data channel
// rather than the PeerConnection; a change here is a change there too.
func (conn *Connection) ConnectionType() (string, error) {
	sctp := conn.pc.SCTP()
	if sctp == nil {
		return "", fmt.Errorf("no SCTP transport")
	}
	dtls := sctp.Transport()
	if dtls == nil {
		return "", fmt.Errorf("no DTLS transport")
	}
	ice := dtls.ICETransport()
	if ice == nil {
		return "", fmt.Errorf("no ICE transport")
	}
	pair, err := ice.GetSelectedCandidatePair()
	if err != nil {
		return "", err
	}
	if pair == nil || pair.Local == nil || pair.Remote == nil {
		return "", fmt.Errorf("no candidate pair selected")
	}
	if pair.Local.Typ == webrtc.ICECandidateTypeRelay || pair.Remote.Typ == webrtc.ICECandidateTypeRelay {
		return "relay", nil
	}
	return "direct", nil
}

// setRemoteDesc sets the remote SDP and flushes any buffered ICE candidates.
// The one setup error whose text carries the peer's bytes is built here,
// once, so the stage cannot drift between its two callers: pion quotes the
// offending SDP token, and SetupError.Error() is what makes that showable.
func (conn *Connection) setRemoteDesc(desc webrtc.SessionDescription) error {
	if err := conn.pc.SetRemoteDescription(desc); err != nil {
		return &SetupError{Stage: StageRemoteDescription, Err: fmt.Errorf("failed to set remote description: %w", err)}
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
	for {
		var rawSignal json.RawMessage
		select {
		case <-conn.done:
			return
		case raw, ok := <-conn.sc.Signal:
			if !ok {
				return
			}
			rawSignal = raw
		}

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
	for {
		select {
		case <-conn.done:
			return
		case c, ok := <-conn.candidates:
			if !ok {
				return
			}
			conn.addRemoteCandidate(c)
		}
	}
}
