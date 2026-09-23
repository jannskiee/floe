// Package transfer implements the Floe data channel protocol for sending files.
//
// Protocol (same as the web app — must stay compatible for CLI↔Browser):
//  1. Sender → Receiver: metadata JSON  (file name, size, index, total, pv, pvMin, ver)
//  2. Receiver → Sender: ack JSON       (confirms ready, offset for resume, pv, pvMin, ver)
//     OR:       incompatible JSON       (sent instead of ack when protocol ranges do not overlap)
//  3. Sender → Receiver: binary chunks  (raw file bytes; chunk size adapts to
//     the negotiated SCTP max-message-size, capped at 256 KB — see chunkSizeFor)
//  4. Sender → Receiver: end JSON       (signals end of this file)
//     Repeat for each file.
//
// pv/pvMin are the protocol version range (see protocol.go). ver is the human
// release string (e.g. "v1.5.5") used only for the optional informational note;
// it never gates the transfer. Fields are omitted by legacy peers and default to
// protocol version 1.
package transfer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"math"
	"os"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pion/webrtc/v4"
	"github.com/schollz/progressbar/v3"
)

const (
	// defaultChunkSize is the safe fallback used when the negotiated SCTP
	// max-message-size is unavailable (0). It matches the historical value.
	defaultChunkSize = 16 * 1024
	// maxChunkSize caps the adaptive chunk. Mirrors MAX_CHUNK in the browser
	// sender (client/lib/transfer/protocol.ts).
	maxChunkSize = 256 * 1024
)

// chunkSizeFor returns the send chunk size for a connection whose negotiated
// SCTP max-message-size is sctpMax (read from dc.Transport().GetCapabilities()).
// It caps at maxChunkSize and never exceeds the negotiated ceiling, so dc.Send
// can never return ErrOutboundPacketTooLarge (pion/sctp enforces the limit on
// send). A zero sctpMax (capabilities not yet available) falls back to the
// proven default.
//
// The ADAPTIVE half mirrors chunkSize() in client/lib/transfer/protocol.ts:
// both cap at 256 KB and both send exactly the negotiated ceiling below it.
// The FALLBACK does not. This is 16 KB and the browser's DEFAULT_CHUNK is
// 64 KB, and both are deliberate: it applies only when the SCTP ceiling is
// unknown, which is exactly when the conservative number is wanted here.
func chunkSizeFor(sctpMax uint32) int {
	if sctpMax == 0 {
		return defaultChunkSize
	}
	if int(sctpMax) < maxChunkSize {
		return int(sctpMax)
	}
	return maxChunkSize
}

// Backpressure watermarks mirror HIGH_WATER and LOW_WATER in the browser sender
// (client/lib/transfer/protocol.ts): pause sending once pion's SCTP send buffer
// reaches the high-water mark, resume once it drains back below the low-water
// mark. Without this the sender enqueues the whole file as fast as the disk
// reads it: the progress bar races to 100% while the receiver is still
// mid-transfer, and large files overflow pion's buffer and stall the connection.
const (
	bufferedAmountHighWater = 8 * 1024 * 1024 // pause sending at/above 8 MB buffered
	bufferedAmountLowWater  = 4 * 1024 * 1024 // resume sending below 4 MB buffered
)

// backpressureStalled reports whether a backpressure wait that just hit its
// timeout should abort the transfer: only when the buffer failed to shrink at
// all over the window. Any drain, however slow, means the peer is alive and
// the wait should continue.
func backpressureStalled(prev, cur uint64) bool {
	return cur >= prev
}

// deliveryStallWindow is how long the delivery wait after the last file lets
// the send buffer go without shrinking before it gives up. It is the
// backpressure wait's window and the receiver's mid-transfer stall watchdog,
// so one rule governs "the transfer stopped making progress" on both ends.
// A var only so tests can shrink it; a test window must be at least four
// drain ticks (200 ms), or the tick arm and the stall arm race.
var deliveryStallWindow = 60 * time.Second

// deliveryBuffered reads the send buffer during the delivery wait. A seam for
// tests, which replace it with a fake that drains, freezes or stays full; the
// package has no t.Parallel, so a process-wide swap is safe.
var deliveryBuffered = func(dc *webrtc.DataChannel) uint64 { return dc.BufferedAmount() }

// metadataMsg is sent before each file to describe it.
type metadataMsg struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	FileName   string `json:"fileName"`
	FileSize   int64  `json:"fileSize"`
	Index      int    `json:"index"`
	Total      int    `json:"total"`
	TotalBytes int64  `json:"totalBytes"`
	Pv         int    `json:"pv,omitempty"`
	PvMin      int    `json:"pvMin,omitempty"`
	Ver        string `json:"ver,omitempty"`
}

// ackMsg is received from the receiver confirming readiness.
type ackMsg struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Offset int64  `json:"offset"`
	Pv     int    `json:"pv"`
	PvMin  int    `json:"pvMin"`
	Ver    string `json:"ver"`
}

// sendFileHashes is whether this sender puts a SHA-256 of each file on that
// file's end frame. It is the rollback lever, a var so a test can turn it off:
// with it false every receiver falls back to the byte-count check it used
// before. The browser has the same lever in client/lib/transfer/protocol.ts.
var sendFileHashes = true

// endMsg is sent after the last chunk of each file. SHA256 carries the digest
// of the bytes this sender put on the wire, and is absent when the file was
// resumed from a nonzero offset or hashing is off. Type is declared first on
// purpose: the transfer audit's hashbad cells match frames that start with
// {"type":"end","sha256":".
type endMsg struct {
	Type   string `json:"type"`
	SHA256 string `json:"sha256,omitempty"`
}

// controlFields reads a receiver's frame as a JSON object and its "type" by
// EXACT key, the way parseReceived does and the browser's classifyControl
// does. A struct tag would match "TYPE" too, so a frame the browser ignores
// used to be honored here. An absent key is a nil RawMessage, which fails to
// decode, so absent and mistyped both read as "not this frame"; a duplicate
// key keeps its last value on both sides. Over the control cap is never
// parsed: that is file data or prose where a control message belongs.
func controlFields(raw []byte) (fields map[string]json.RawMessage, typ string, ok bool) {
	if len(raw) > controlMsgMax {
		return nil, "", false
	}
	if json.Unmarshal(raw, &fields) != nil || json.Unmarshal(fields["type"], &typ) != nil {
		return nil, "", false
	}
	return fields, typ, true
}

// peerReason is what abortFromPeer returns for an incompatible frame it cannot
// name with a code: the peer's own account, either rebuilt locally from pv and
// pvMin or passed through displayText. It carries no new information; it exists
// so the send loop can tell an error that came off the wire from one of its own
// and leave the local file name off it (F-SHA-3). Error() is byte for byte the
// text errors.New returned before, so every caller that compares the string,
// including FuzzAbortFromPeer and TestSenderUnknownCodeKeepsReasonText, is
// unaffected. Unexported and never wrapped: nothing outside this file should
// match on it, and errors.As is the only reader.
type peerReason struct{ text string }

func (e *peerReason) Error() string { return e.text }

// fromPeer reports whether err arrived on the wire rather than being raised by
// this sender. Both shapes abortFromPeer can return count; nothing else does.
// Deliberately errors.As on two concrete pointer types and not errors.Is:
// neither type has Unwrap, and giving peerReason one would let a local
// fmt.Errorf("...: %w", ...) masquerade as peer-originated.
func fromPeer(err error) bool {
	var stopped *PeerStoppedError
	var reason *peerReason
	return errors.As(err, &stopped) || errors.As(err, &reason)
}

// abortFromPeer reads the receiver's "incompatible" frame and returns the
// error the send ends with, or nil when raw is not that frame.
//
// A known code makes it a *PeerStoppedError: the code after ParseRefusalCode
// and saved clamped to [0, total], and nothing else from the frame. The peer's
// prose stops here. A known code wins over the pv range, because a current
// peer always sends an overlapping range and the browser's refusalCodeOf
// ignores pv the same way. Without a known code the frame reads as it always
// has: compatErrorFromIncompatible rebuilds a version mismatch from pv/pvMin,
// or prints the reason through displayText for a peer that predates code.
//
// code and saved are read from the raw map, by exact key, not from the
// struct: a struct tag would accept {"CODE":"declined"}, which the browser
// rejects. The struct decode is kept for the display fields and tolerates a
// *json.UnmarshalTypeError, because encoding/json fills every well-typed
// field before reporting the first mistyped one, so a hostile "saved":"x"
// must not drop the frame and leave the sender waiting (the FND-4 class).
//
// The per-file ack loop already handles this frame, but it only runs while a
// NEXT file is coming. A receiver that refuses the LAST file, which is every
// single-file transfer, sends its reason into the drain loop instead, and the
// drain loop used to discard it and print a success summary over a receiver
// that kept nothing.
func abortFromPeer(raw []byte, localVer, updateHint string, total int) error {
	fields, typ, ok := controlFields(raw)
	if !ok || typ != "incompatible" {
		return nil
	}
	var incompat incompatibleMsg
	var typeErr *json.UnmarshalTypeError
	if err := json.Unmarshal(raw, &incompat); err != nil && !errors.As(err, &typeErr) {
		return nil
	}
	if code, known := refusalCodeIn(fields); known {
		return &PeerStoppedError{Code: code, Saved: savedCountIn(fields, total)}
	}
	return &peerReason{compatErrorFromIncompatible(localVer, updateHint, incompat)}
}

// waitFlushed waits until the forwarder has moved every frame that arrived
// before the close into ackCh. After the close it does only non-blocking
// work, so this returns at once in practice; the bound is a backstop.
func waitFlushed(flushed <-chan struct{}) {
	select {
	case <-flushed:
	case <-time.After(time.Second):
	}
}

// stopBeforeClose is what a wait checks when the channel has closed. A
// receiver that refuses sends its incompatible frame, flushes it and then
// closes, so on this side the frame and the close can be ready at once; a
// refusal that arrived must be reported as the refusal, never as a lost
// connection. It returns the first refusal among the frames still queued in
// ackCh (read through abortFromPeer, the one reader), or nil. Every other
// frame it reads is dropped: the close ends the wait either way.
func stopBeforeClose(ackCh <-chan []byte, flushed <-chan struct{}, localVer, updateHint string, total int) error {
	waitFlushed(flushed)
	for {
		select {
		case raw := <-ackCh:
			if len(raw) > controlMsgMax {
				continue
			}
			if err := abortFromPeer(raw, localVer, updateHint, total); err != nil {
				return err
			}
		default:
			return nil
		}
	}
}

// refusalAfterSendError is the check a failed Send makes. pion marks the
// channel Closed before it runs onClose, so a Send in that window fails with
// io.ErrClosedPipe while the receiver's refusal already sits in ackCh and
// done has not fired yet (FT-GO-REFUSAL review F1). It waits up to a second
// for done, which follows within microseconds, and then reports a queued
// refusal through stopBeforeClose; nil keeps the Send's own error. When no
// close follows at all, the error path takes about two seconds: this second
// plus stopBeforeClose's wait for the flush (review 2, R2-3, measured).
func refusalAfterSendError(done <-chan struct{}, ackCh <-chan []byte, flushed <-chan struct{}, localVer, updateHint string, total int) error {
	select {
	case <-done:
	case <-time.After(time.Second):
	}
	return stopBeforeClose(ackCh, flushed, localVer, updateHint, total)
}

// refusalCodeIn is the one reader of a peer's code: a JSON string that
// ParseRefusalCode knows, else nothing. Not a string (a number, null, an
// object) is nothing, never an error, because the field is optional.
func refusalCodeIn(fields map[string]json.RawMessage) (RefusalCode, bool) {
	lit := fields["code"]
	if len(lit) == 0 || lit[0] != '"' {
		return "", false
	}
	var s string
	if json.Unmarshal(lit, &s) != nil {
		return "", false
	}
	return ParseRefusalCode(s)
}

// savedCountIn reads the peer's count of committed files the way the browser
// sender does: an integer-valued JSON number, clamped to [0, total]; anything
// else (absent, a string, null, a fraction, out of float64 range) is 0. 3.0
// is 3 and 1e300 clamps to total on both sides, because JSON.parse makes
// them numbers first and Number.isInteger accepts both.
func savedCountIn(fields map[string]json.RawMessage, total int) int {
	lit := fields["saved"]
	// A number starts with a digit or a minus. The byte test comes first because
	// null decodes into a float64 without an error.
	if len(lit) == 0 || (lit[0] != '-' && (lit[0] < '0' || lit[0] > '9')) {
		return 0
	}
	var n float64
	if json.Unmarshal(lit, &n) != nil || n != math.Trunc(n) {
		return 0
	}
	switch {
	case n < 0:
		return 0
	case n > float64(total):
		return total
	}
	return int(n)
}

// parseReceived reports whether raw is the receiver's delivery confirmation
// and, when it carries a usable one, how many files the receiver says matched
// their SHA-256. The size bound is the same one the ack loop applies: a frame
// larger than a control message is file data and must never be JSON-parsed.
//
// verified is read separately, by its exact key as raw JSON, after the type.
// A mistyped optional field must never fail the whole decode and drop the
// frame, or a hostile "verified" would keep the delivery wait running (the
// FND-4 class). hasVerified is true only for an integer-valued JSON number from
// 0 to files. 3.0 and 1e0 count, because JSON.parse makes them 3 and 1 and the
// browser twin (verifiedCountOf) must decide every frame the same way.
// Anything else is absent, never clamped: 999 of 3 is a broken receiver, not
// "all matched". The count is the receiver's claim, used only for equality
// with the file count.
//
// The type is read by its exact key too. A struct tag matches keys without
// regard to case, so {"TYPE":"received"} used to count as a delivery
// confirmation here while the browser twin ignores it (found by
// FuzzParseReceived, CP-0 campaign, 2026-09-18).
func parseReceived(raw []byte, files int) (ok bool, verified int, hasVerified bool) {
	if len(raw) > controlMsgMax {
		return false, 0, false
	}
	var fields map[string]json.RawMessage
	var typ string
	if json.Unmarshal(raw, &fields) != nil || json.Unmarshal(fields["type"], &typ) != nil || typ != "received" {
		return false, 0, false
	}
	lit := fields["verified"]
	// A number starts with a digit or a minus. The byte test comes first because
	// null decodes into a float64 without an error.
	if len(lit) == 0 || (lit[0] != '-' && (lit[0] < '0' || lit[0] > '9')) {
		return true, 0, false
	}
	var n float64
	if json.Unmarshal(lit, &n) != nil || n != math.Trunc(n) || n < 0 || n > float64(files) {
		return true, 0, false
	}
	return true, int(n), true
}

// SendOptions carries optional behavior for GUI clients. The zero value is
// the CLI behavior: terminal progress and the CLI update instruction.
type SendOptions struct {
	OnProgress ProgressFunc
	// OnDelivered fires exactly once, after the delivery wait ends and before
	// the summary is printed, with the same numbers the Verified row reads. It
	// does not fire on any error path. Leave nil for the CLI.
	OnDelivered func(Delivered)
	// UpdateHint replaces the CLI-only local update instruction in protocol
	// compatibility errors. Leave empty for the default CLI wording.
	UpdateHint string
	// AckTimeout bounds the wait for each file's first ack. Zero keeps
	// defaultAckTimeout, which is sized for a person at this machine's own
	// "Accept? [Y/n]" prompt. A request-link visitor passes
	// VisitorAckTimeout + VisitorAckGrace instead, because the person deciding
	// is on the other side of a link and the deciding side answers on their
	// behalf one grace earlier. Nothing else in this sender is armed while it
	// waits, so a longer value costs one timer and changes no other behavior.
	AckTimeout time.Duration
	// Messages and Closed come from peer.Connection.Early(), which wires the data
	// channel the instant it exists. Pass BOTH whenever the channel came from
	// peer.SetupAsSender. The sender has never been observed losing this race,
	// because the receiver does more work before it acks than the sender does
	// before it listens, but the window is the same one and it is the same
	// silent, permanent drop. See peer.Early.
	Messages <-chan webrtc.DataChannelMessage
	Closed   <-chan struct{}
}

// SendFiles sends all given file paths over the open data channel, rendering a
// terminal progress bar. Folders are walked recursively. localVer is the human
// release string (e.g. "v1.5.5") embedded in metadata; pass "" for dev/tests.
func SendFiles(dc *webrtc.DataChannel, paths []string, localVer string) error {
	return SendFilesWithOptions(dc, paths, localVer, SendOptions{})
}

// SendFilesWithOptions is the full-featured send entry point; SendFiles
// delegates here.
func SendFilesWithOptions(dc *webrtc.DataChannel, paths []string, localVer string, opts SendOptions) error {
	onProgress := opts.OnProgress
	// Expand paths: collect all files (walk directories)
	files, err := collectFiles(paths)
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return fmt.Errorf("no files to send")
	}

	var totalBytes int64
	for _, e := range files {
		totalBytes += e.size
	}

	// Relay size cap: decide before wiring acks or sending any metadata. The
	// connection is already established by the time SendFiles runs, so the
	// selected ICE pair is known. Mirrors the browser's relay gate.
	if err := relayGate(dc, totalBytes); err != nil {
		// Tell the receiver, or all it sees is a close. Its own diagnosis for
		// that is "the sender canceled, or the transfer was blocked", and a
		// browser receiver used to go further and blame a relay that is
		// already on. Sent as TEXT because this direction is the one file data
		// travels; see abortReason.
		abortReason(dc, localVer, err.Error(), true)
		return err
	}

	start := time.Now()

	// ackCh receives JSON ack messages from the receiver.
	// Accept ack as either string or binary: the CLI receiver sends binary for
	// browser compatibility, CLI-to-CLI also works.
	// Non-blocking: a full buffer means a stray/duplicate message arrived;
	// dropping it is safe because the ack loop already matched its ID.
	ackCh := make(chan []byte, 4)
	// flushed is closed once every frame that arrived before the channel
	// closed is in ackCh, so a wait that sees the close can still read the
	// refusal a receiver sends just before it closes (stopBeforeClose).
	flushed := make(chan struct{})
	if opts.Messages != nil && opts.Closed != nil {
		// The pump was installed with the data channel, so the receiver's first
		// ack cannot have arrived before anyone was listening. Forwarding into
		// ackCh rather than reading opts.Messages directly leaves every deadline
		// below exactly as it was.
		go func() {
			defer close(flushed)
			forward := func(msg webrtc.DataChannelMessage) {
				select {
				case ackCh <- msg.Data:
				default:
				}
			}
			for {
				select {
				case msg, ok := <-opts.Messages:
					if !ok {
						return
					}
					forward(msg)
				case <-opts.Closed:
					// A refusal is the last frame a receiver sends before it
					// closes, and both can be ready here at once: a random pick
					// used to return with the refusal still in Messages. The
					// pump fills Messages before it closes Closed (pion delivers
					// a message before the close, from one read goroutine), so
					// moving what is queued now leaves nothing behind.
					for {
						select {
						case msg, ok := <-opts.Messages:
							if !ok {
								return
							}
							forward(msg)
						default:
							return
						}
					}
				}
			}
		}()
	} else {
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			select {
			case ackCh <- msg.Data:
			default:
			}
		})
		// pion runs OnMessage before OnClose on the same read goroutine, so
		// every frame is in ackCh by the time done fires.
		close(flushed)
	}

	// done is closed when the data channel closes, letting every wait below
	// fail fast instead of burning its full deadline. pion fires OnClose on
	// GRACEFUL closes only (remote dc.Close/pc.Close/browser tab close send a
	// close notification): a kill -9 or dead network does not error the read
	// chain promptly (sctp retransmits by design; an ICE failure closes the
	// association only indirectly, when a pending retransmission finds no
	// candidate pair), so the 120 s ack wait and the 60 s no-progress windows
	// of the backpressure and delivery waits remain the backstop for ungraceful
	// death.
	//
	// Taken from the pump when there is one. Registering our own OnClose would
	// REPLACE the pump's, since pion keeps a single handler per event, and the
	// pump needs its own close signal to be sure its send can never block.
	var done <-chan struct{}
	if opts.Closed != nil {
		done = opts.Closed
	} else {
		d := make(chan struct{})
		var closeOnce sync.Once
		dc.OnClose(func() {
			closeOnce.Do(func() { close(d) })
		})
		done = d
	}

	// Backpressure: pion calls OnBufferedAmountLow once the send buffer drains
	// to bufferedAmountLowWater. The send loop blocks on sendMore whenever the
	// buffer is full so we never enqueue faster than the peer can drain.
	sendMore := make(chan struct{}, 1)
	dc.SetBufferedAmountLowThreshold(bufferedAmountLowWater)
	dc.OnBufferedAmountLow(func() {
		select {
		case sendMore <- struct{}{}:
		default:
		}
	})

	// Size chunks to the connection's negotiated SCTP max-message-size (capped
	// at maxChunkSize), matching the browser sender. Larger chunks mean far fewer
	// dc.Send calls per file — the main throughput lever on fast links.
	var sctpMax uint32
	if t := dc.Transport(); t != nil {
		sctpMax = t.GetCapabilities().MaxMessageSize
	}
	chunk := chunkSizeFor(sctpMax)

	var sentSoFar int64
	for i, entry := range files {
		if err := sendFile(dc, ackCh, sendMore, done, flushed, entry, i+1, len(files), totalBytes, localVer, onProgress, opts.UpdateHint, ackTimeoutOrDefault(opts.AckTimeout), sentSoFar, chunk); err != nil {
			// A refusal the PEER sent is returned as it came. The wrap named
			// entry.displayName, which is the file the sender had already moved
			// on to: a receiver refuses file N after its end marker, and the
			// frame lands while file N+1 waits for its ack, so the wrong file
			// was blamed in every multi-file batch (F-SHA-3). The wrap still
			// belongs on this sender's own failures, where the name is the
			// whole point.
			if fromPeer(err) {
				return err
			}
			return fmt.Errorf("error sending %s: %w", entry.displayName, err)
		}
		sentSoFar += entry.size
	}

	// Wait for delivery confirmation before closing.
	//
	// CLI receivers send {"type":"received"} after writing and verifying every
	// byte, which is the authoritative signal. Browser receivers don't send it,
	// but they keep their connection alive so the SCTP buffer naturally drains
	// to zero, which is the fallback.
	//
	// We cannot rely solely on dc.BufferedAmount()==0: when the receiver closes
	// its connection immediately after the last write (which the CLI does), the
	// final SACKs may never arrive and the buffer stalls at a non-zero value
	// even though all bytes were delivered successfully.
	//
	// Up to bufferedAmountHighWater (8 MB) can still be queued when this wait
	// starts, so it must not have a fixed deadline: a fixed 30 s one aborted,
	// at 94 to 99 percent, every transfer that still had more than it could
	// drain in 30 s (about 4 MB at 1.1 Mbps, so every file above the low-water
	// mark on a slow end), and the receiver then deleted the file (reproduced at
	// 250 ms RTT with 1 percent loss). Instead it gives up only after a full
	// deliveryStallWindow in which the buffer did not shrink at all, the rule
	// the backpressure wait uses. Whichever comes first, done or a frozen
	// buffer, ends the wait within about one window. The one unbounded case is
	// a receiver that trickles SACKs (one chunk per window drains 8 MB over
	// days); a user cancel, which closes the connection and fires done, ends
	// it, and a host that must bound a session cancels in its own layer.
	// Only the stall arm updates lastBuffered: a sample from the 50 ms tick arm
	// would compare two reads 50 ms apart and abort a slow but live drain.
	// What the receiver's received frame reported, read by the summary below.
	var verified int
	var hasVerified bool
	lastBuffered := deliveryBuffered(dc)
	stall := time.NewTimer(deliveryStallWindow)
	defer stall.Stop()
	drainTick := time.NewTicker(50 * time.Millisecond)
	defer drainTick.Stop()
drainLoop:
	for {
		select {
		case raw := <-ackCh:
			if len(raw) > controlMsgMax {
				continue // same bound as the ack loop in sendFile
			}
			if err := abortFromPeer(raw, localVer, opts.UpdateHint, len(files)); err != nil {
				return err
			}
			if ok, v, has := parseReceived(raw, len(files)); ok {
				verified, hasVerified = v, has
				break drainLoop
			}
		case <-drainTick.C:
			if deliveryBuffered(dc) == 0 {
				break drainLoop
			}
		case <-done:
			// Success must win this race. pion delivers OnMessage before
			// OnClose from the same read goroutine, so a "received" the peer
			// sent just before closing is already sitting in ackCh: consult it
			// before judging the close. And BufferedAmount is untrustworthy
			// here (the SACK race above), so a nonzero value only means
			// delivery could not be confirmed, never that data was lost.
			// With the pump, "already sitting in ackCh" holds only once the
			// forwarder has moved what was still queued at the close.
			waitFlushed(flushed)
		drainAcks:
			for {
				select {
				case raw := <-ackCh:
					if len(raw) > controlMsgMax {
						continue
					}
					if err := abortFromPeer(raw, localVer, opts.UpdateHint, len(files)); err != nil {
						return err
					}
					if ok, v, has := parseReceived(raw, len(files)); ok {
						verified, hasVerified = v, has
						break drainLoop
					}
				default:
					break drainAcks
				}
			}
			if left := deliveryBuffered(dc); left != 0 {
				return fmt.Errorf("connection closed before delivery was confirmed (%d bytes unacknowledged)", left)
			}
			break drainLoop
		case <-stall.C:
			cur := deliveryBuffered(dc)
			if cur == 0 {
				break drainLoop // drained; the tick arm usually sees this first
			}
			if backpressureStalled(lastBuffered, cur) {
				return fmt.Errorf("timed out waiting for delivery confirmation from peer")
			}
			lastBuffered = cur
			stall.Reset(deliveryStallWindow)
		}
	}

	elapsed := time.Since(start)
	timeVal := formatDuration(elapsed)
	if spd := formatSpeed(float64(totalBytes) / elapsed.Seconds()); spd != "" {
		timeVal += " · avg " + spd
	}
	// Every return inside drainLoop is an error path and skips this by
	// construction, which is what "fires exactly once, on success only, before
	// SendFilesWithOptions returns" means.
	if opts.OnDelivered != nil {
		opts.OnDelivered(Delivered{Files: len(files), Verified: verified, HasVerified: hasVerified})
	}
	rows := [][2]string{
		{"Sent", fmt.Sprintf("%s (%s)", pluralize(len(files), "file"), formatBytes(totalBytes))},
	}
	// The receiver's report, not a proof made here: shown only when it said
	// every file matched.
	if hasVerified && verified == len(files) && len(files) > 0 {
		rows = append(rows, [2]string{"Verified", "SHA-256 matched"})
	}
	rows = append(rows, [2]string{"Time", timeVal})
	printSummary(rows)
	return nil
}

// sendFile handles the full send sequence for a single file.
func sendFile(dc *webrtc.DataChannel, ackCh <-chan []byte, sendMore <-chan struct{}, done <-chan struct{}, flushed <-chan struct{}, entry fileEntry, index, total int, totalBytes int64, localVer string, onProgress ProgressFunc, updateHint string, ackTimeout time.Duration, baseTotal int64, chunk int) error {
	f, err := os.Open(entry.absPath)
	if err != nil {
		return err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return err
	}

	fileID := uuid.New().String()
	fileSize := info.Size()

	// Step 1: Send metadata
	meta := metadataMsg{
		Type:       "metadata",
		ID:         fileID,
		FileName:   entry.displayName,
		FileSize:   fileSize,
		Index:      index,
		Total:      total,
		TotalBytes: totalBytes,
		Pv:         ProtocolVersion,
		PvMin:      MinProtocolVersion,
		Ver:        localVer,
	}
	metaJSON, _ := json.Marshal(meta)
	if err := dc.SendText(string(metaJSON)); err != nil {
		if stop := refusalAfterSendError(done, ackCh, flushed, localVer, updateHint, total); stop != nil {
			return stop
		}
		return fmt.Errorf("failed to send metadata: %w", err)
	}

	// Step 2: Wait for this file's ack, bounded by ackTimeout.
	// Discard any stray or stale message until we see the ack whose ID matches
	// this file — otherwise an out-of-order message could be misread as the ack
	// (sending from offset 0) or leak into the next file's handshake.
	// The default, defaultAckTimeout in deadlines.go, is 120 s: enough for a
	// human at the interactive [Y/n] receiver prompt to accept without
	// triggering a spurious timeout on the sender. A request-link visitor
	// passes a much longer one through SendOptions.AckTimeout, because the
	// person deciding is not at this keyboard. That is safe to lengthen
	// because this wait arms nothing else: the delivery stall timer and the
	// drain ticker are created after every file's ack, and the backpressure
	// wait below is created inside the chunk loop this loop breaks into.
	// TestSenderAckWaitArmsNothingElse pins that shape.
	var offset int64
	ackDeadline := time.After(ackTimeout)
ackLoop:
	for {
		select {
		case raw := <-ackCh:
			// Same bound the browser's waitForAck gets from classifyControl: a real ack
			// or incompatible is a few hundred bytes, and peer prose past this is
			// never something to parse, let alone print.
			if len(raw) > controlMsgMax {
				continue
			}
			// A receiver that refuses sends an "incompatible" instead of an
			// ack: a version mismatch, or a refusal from its metadata arm that
			// lands during this wait. The same reader as the drain loop, so a
			// known code returns the same *PeerStoppedError wherever it lands.
			if err := abortFromPeer(raw, localVer, updateHint, total); err != nil {
				return err
			}
			// The type by exact key, as everywhere else the sender reads the
			// receiver's frames, so {"TYPE":"ack"} is ignored here as the
			// browser ignores it.
			if _, typ, ok := controlFields(raw); ok && typ == "ack" {
				var ack ackMsg
				if err := json.Unmarshal(raw, &ack); err == nil && ack.ID == fileID {
					// Defense in depth: verify protocol compat from the receiver's
					// pv fields on the first file. The receiver already checked from
					// its side; this catches the case where an old receiver (no pv
					// field, treated as v1) connects to a future sender that dropped
					// support for v1.
					if index == 1 {
						ok, localTooOld := CheckCompat(MinProtocolVersion, ProtocolVersion, ack.PvMin, ack.Pv)
						if !ok {
							return fmt.Errorf("%s", compatErrorMessage(localTooOld, localVer, ack.Ver,
								MinProtocolVersion, ProtocolVersion, ack.PvMin, ack.Pv, updateHint))
						}
						if ack.Ver != "" && localVer != "" && ack.Ver != localVer {
							fmt.Printf("  Peer version: %s\n", displayText(ack.Ver, maxDisplayVer))
						}
					}
					// The offset is the receiver's word for how much of this
					// file it already has, straight off the wire. Outside the
					// file it is a receiver bug or a hostile peer: a negative
					// one made Seek fail with a bare "invalid argument", and
					// one past the end sent zero bytes plus an end marker the
					// receiver then refused as incomplete. Name the number
					// instead, before the file is touched.
					if ack.Offset < 0 || ack.Offset > fileSize {
						return fmt.Errorf("receiver asked to resume at byte %d of a %d-byte file", ack.Offset, fileSize)
					}
					offset = ack.Offset
					break ackLoop
				}
			}
			// Not our ack — keep waiting.
		case <-done:
			// A decline (the receiver's [Y/n] prompt closes the channel) or a
			// receiver error-exit lands here in about a second instead of
			// burning the full ack deadline. A refusal sent just before the
			// close can be ready in ackCh at the same moment, and Go picks
			// between ready cases at random: report it first.
			if err := stopBeforeClose(ackCh, flushed, localVer, updateHint, total); err != nil {
				return err
			}
			return fmt.Errorf("connection closed while waiting for the receiver (transfer declined or receiver exited)")
		case <-ackDeadline:
			return fmt.Errorf("timed out waiting for ack")
		}
	}

	// Seek to resume offset (normally 0)
	if offset > 0 {
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			return fmt.Errorf("failed to seek to offset: %w", err)
		}
	}

	// Step 3: Send binary chunks, reporting progress through the terminal bar
	// (CLI) or the callback (GUI, when onProgress is non-nil).
	var bar *progressbar.ProgressBar
	if onProgress == nil {
		bar = newProgressBar(fileSize, index, total, entry.displayName)
		bar.Set64(offset)
	}
	// The digest covers exactly the bytes handed to dc.Send, so it describes
	// what the receiver got rather than what is on disk now. Only from offset 0:
	// a resumed file would hash a suffix, and the receiver hashes the whole file.
	var hasher hash.Hash
	if sendFileHashes && offset == 0 {
		hasher = sha256.New()
	}
	sentFile := offset
	report := func(n int) {
		sentFile += int64(n)
		if bar != nil {
			bar.Add(n)
			return
		}
		onProgress(Progress{
			FileName:   entry.displayName,
			FileIndex:  index,
			FileCount:  total,
			FileBytes:  sentFile,
			FileSize:   fileSize,
			TotalBytes: baseTotal + sentFile,
			GrandTotal: totalBytes,
		})
	}
	if onProgress != nil {
		report(0) // emit the starting point (handles resume offset and 0-byte files)
	}

	// Hold the read to the size the metadata announced. Between the Stat above
	// and this loop the file can change on disk: an active log, a download still
	// running, a video still being written. Reading to EOF put MORE bytes on the
	// wire than were promised, and the receiver then killed the whole batch with
	// "sender exceeded the announced size", which names nothing either person can
	// act on. The browser sender cannot make this mistake: a File's size is a
	// snapshot, and both its loop bound and its slice end clamp to it.
	announced := io.LimitReader(f, fileSize-offset)

	buf := make([]byte, chunk)
	for {
		n, err := announced.Read(buf)
		if n > 0 {
			// Backpressure: block until pion's buffer drains below the low-water
			// mark before queuing more. The loop re-checks after each wakeup so a
			// stale signal can't let us run away from the receiver. Abort only
			// when the buffer makes no progress across a full 60 s window: a
			// slow-but-draining relay (below ~70 KB/s the 4 MB drain takes over
			// a minute) must not kill the transfer.
			lastBuffered := dc.BufferedAmount()
			for dc.BufferedAmount() >= bufferedAmountHighWater {
				select {
				case <-sendMore:
				case <-done:
					// This wait reads no frames, so a receiver that refused
					// mid-file (disk-full, write-failed) and then closed left
					// its reason unread in ackCh: report it before the close.
					if err := stopBeforeClose(ackCh, flushed, localVer, updateHint, total); err != nil {
						return err
					}
					return fmt.Errorf("connection closed mid-transfer (%d bytes still buffered)", dc.BufferedAmount())
				case <-time.After(60 * time.Second):
					cur := dc.BufferedAmount()
					if backpressureStalled(lastBuffered, cur) {
						return fmt.Errorf("backpressure stall: peer not draining (%d bytes buffered)", cur)
					}
					lastBuffered = cur
				}
			}
			if sendErr := dc.Send(buf[:n]); sendErr != nil {
				if stop := refusalAfterSendError(done, ackCh, flushed, localVer, updateHint, total); stop != nil {
					return stop
				}
				return fmt.Errorf("failed to send chunk: %w", sendErr)
			}
			if hasher != nil {
				hasher.Write(buf[:n]) // hash.Hash never returns an error
			}
			report(n)
			// A receiver that stops us mid-file, because it caught an over-run,
			// has nowhere else to be heard: this loop is the only thing running.
			// Non-blocking, so a quiet peer costs nothing.
			select {
			case raw := <-ackCh:
				if err := abortFromPeer(raw, localVer, updateHint, total); err != nil {
					return err
				}
			default:
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("error reading file: %w", err)
		}
	}

	// The file changed under the send. Say so here, where the cause is still
	// visible, instead of sending an end marker and leaving the receiver to report
	// a byte count that reads like a network fault.
	changed := fmt.Sprintf("the sender's copy of %q changed while it was being sent, so nothing further was sent", entry.displayName)
	if sentFile != fileSize {
		// The receiver is mid-file with an unfinished .part and no idea why the
		// bytes stopped. Name it, or its own diagnosis is a stalled connection.
		abortReason(dc, localVer, changed, true)
		return fmt.Errorf("the file shrank while it was being sent (announced %d bytes, read %d); send it again once it stops changing",
			fileSize, sentFile)
	}
	// Growth is probed off the descriptor, never a second Stat. A descriptor that
	// stats as 0 and still yields bytes (a log created moments earlier, or a
	// /proc, /sys or character-device path, all of which collectFiles accepts) is
	// exactly what a re-stat cannot see, and capping it silently would send an
	// empty file that both ends reported as a success.
	//
	// Only for a regular file. A FIFO or a character device would block this
	// read forever, and collectFiles accepts whatever os.Stat succeeded on.
	if info.Mode().IsRegular() {
		var probe [1]byte
		if n, _ := f.Read(probe[:]); n > 0 {
			abortReason(dc, localVer, changed, true)
			return fmt.Errorf("the file grew while it was being sent (announced %d bytes); send it again once it stops changing",
				fileSize)
		}
	}

	if bar != nil {
		fmt.Println()
	}

	// Step 4: Send end marker, with the digest when it covers the whole file.
	end := endMsg{Type: "end"}
	if hasher != nil {
		end.SHA256 = hex.EncodeToString(hasher.Sum(nil))
	}
	endJSON, _ := json.Marshal(end)
	if err := dc.SendText(string(endJSON)); err != nil {
		if stop := refusalAfterSendError(done, ackCh, flushed, localVer, updateHint, total); stop != nil {
			return stop
		}
		return err
	}
	return nil
}
