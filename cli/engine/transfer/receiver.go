package transfer

// The receive side of the data channel protocol. See sender.go for the full
// protocol description, which is also the package doc.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/schollz/progressbar/v3"
)

// Receive-loop stall watchdog. Before the first metadata the sender needs no
// human input and metadata is due about one RTT after the channel opens, so a
// silent 30 s means the transfer path is dead (the captured CI failure mode:
// both sides log Connected, then nothing). Mid-transfer the bar is higher:
// pion/sctp's retransmission timeout backs off toward 60 s on a lossy path and
// the sender's own backpressure abort uses a 60 s window, so anything shorter
// would kill transfers that are still legitimately recovering. Vars, not
// consts, so tests can shrink them.
var (
	receiveIdleTimeout  = 30 * time.Second
	receiveStallTimeout = 60 * time.Second
)

// syncPart flushes a finished .part before its ownership check. A seam, like
// the timeouts above: a real delayed write failure (a network share, a USB
// bridge) cannot be produced on demand, so tests swap in one that fails.
var syncPart = func(f *os.File) error { return f.Sync() }

// writePart puts a chunk into the open .part and openPart claims one. Seams
// like syncPart: a full drive, or a name the filesystem refuses at claim
// time, cannot be produced on demand either, so tests swap in ones that fail.
var (
	writePart = func(f *os.File, b []byte) (int, error) { return f.Write(b) }
	openPart  = claimPart
)

// FileInfo describes an incoming file (parsed from metadata message).
type FileInfo struct {
	ID         string
	FileName   string
	FileSize   int64
	Index      int
	Total      int
	TotalBytes int64
	Pv         int    // sender's highest protocol version (0 = legacy, treat as 1)
	PvMin      int    // sender's minimum protocol version (0 = legacy, treat as 1)
	Ver        string // sender's human release string, e.g. "v1.5.5"
}

// reportBytesToServer posts the received byte count to the server's stats
// endpoint after a successful transfer. Fire-and-forget: errors are silently
// ignored so a network hiccup never affects the transfer outcome.
func reportBytesToServer(serverURL string, byteCount int64) {
	if serverURL == "" {
		return
	}
	payload, _ := json.Marshal(map[string]int64{"bytes": byteCount})
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Post(serverURL+"/api/stats/report", "application/json", bytes.NewReader(payload))
	if err != nil {
		return
	}
	resp.Body.Close()
}

// IncomingInfo describes a transfer at the moment its first metadata arrives,
// before any file is created, any ack is sent, or any byte lands on disk.
type IncomingInfo struct {
	Files      int    `json:"files"`      // total files in the batch
	TotalBytes int64  `json:"totalBytes"` // batch size; falls back to the single file's size, 0 when the sender predates totalBytes
	FirstName  string `json:"firstName"`  // sender-supplied name of the first file after displayText (controls and bidi marks replaced, at most maxDisplayName runes); display only, NOT the on-disk name
	FirstSize  int64  `json:"firstSize"`  // announced size of the first file, validated by byteCount like every other number here; a size warning reads this, never TotalBytes
}

// FileDone describes one file committed under its final name.
type FileDone struct {
	SavedName string `json:"savedName"` // on-disk name relative to the output folder, the same value Progress.SavedName carries
	Bytes     int64  `json:"bytes"`     // bytes written, equal to the announced size (the end handler refuses anything else)
	Verified  bool   `json:"verified"`  // the sender sent a SHA-256 and it matched the bytes as they were written
}

// ReceiveOptions carries the optional callbacks for GUI clients. The zero
// value is the CLI behavior: terminal progress bar, no incoming preview.
// Callbacks run synchronously on the receive loop, so keep them fast.
type ReceiveOptions struct {
	OnProgress ProgressFunc
	OnIncoming func(IncomingInfo)
	// OnFileDone fires once per committed file, after the rename and any
	// numbered-sibling correction, and never for a refused file. It delays the
	// next ack, so keep it fast, never call back into the engine and never
	// block on UI.
	OnFileDone func(FileDone)
	// Decide, when non-nil, is consulted exactly once and synchronously, right
	// after OnIncoming for the first metadata: after the compatibility check,
	// before any directory or staging file is created and before the first
	// ack. It may block for as long as the person it is asking takes, because
	// nothing here is armed while it runs, and it MUST return when Closed
	// fires. It owns its own deadline. Nil keeps the terminal prompt below and
	// today's behavior.
	Decide func(IncomingInfo) Decision
	// Limits, when non-nil, is the request link's receive policy (layer 2),
	// checked at fixed points of the loop below. Nil keeps layer 2 off. Layer
	// 1, the universal sanity limits in limits.go, runs either way and has no
	// field here on purpose.
	Limits *ReceiveLimits
	// UpdateHint replaces the CLI-only local update instruction in protocol
	// compatibility errors. Leave empty for the default CLI wording.
	UpdateHint string
	// Messages and Closed come from peer.Connection.Early(), which wires the data
	// channel the instant it exists. Pass BOTH whenever the channel came from
	// peer.SetupAsReceiver: registering handlers here instead is a race against
	// pion's read loop, and the message it loses is the sender's first, so the
	// transfer hangs with both ends reporting a healthy connection. Leave both
	// nil only for a channel you created and left unhandled.
	Messages <-chan webrtc.DataChannelMessage
	Closed   <-chan struct{}
}

// ReceiveFiles handles the full receiving side of the Floe protocol.
// It blocks until all files are received. Files are written to outputDir.
// If autoAccept is false, the user is prompted before receiving begins.
// localVer is the human release string (e.g. "v1.5.5") embedded in the ack
// for the optional peer-version note; pass "" for dev builds or tests.
// serverURL is the signaling server base URL used to report transfer stats;
// pass "" to skip reporting (e.g. in tests).
func ReceiveFiles(dc *webrtc.DataChannel, outputDir string, autoAccept bool, localVer string, serverURL string) error {
	return ReceiveFilesWithOptions(dc, outputDir, autoAccept, localVer, serverURL, ReceiveOptions{})
}

// ReceiveFilesWithProgress is ReceiveFiles with a progress callback for GUI
// clients. When onProgress is non-nil, per-chunk progress is reported through it
// and the terminal progress bar is suppressed.
func ReceiveFilesWithProgress(dc *webrtc.DataChannel, outputDir string, autoAccept bool, localVer string, serverURL string, onProgress ProgressFunc) error {
	return ReceiveFilesWithOptions(dc, outputDir, autoAccept, localVer, serverURL, ReceiveOptions{OnProgress: onProgress})
}

// ReceiveFilesWithOptions is the full-featured receive entry point; the other
// two delegate here. opts.OnIncoming, when set, fires exactly once as the
// first metadata arrives, after the protocol compatibility check and before
// any file is created or acked, and opts.Decide is asked at that same point
// whether the transfer happens at all.
func ReceiveFilesWithOptions(dc *webrtc.DataChannel, outputDir string, autoAccept bool, localVer string, serverURL string, opts ReceiveOptions) error {
	onProgress := opts.OnProgress
	// Where this receive claims, reports and saves: outputDir until a Decide
	// accepts with an OutputDir of its own, and that one from then on. Every
	// site that joins a name, makes one relative or prints the folder reads
	// this, never outputDir, so a drop accepted into a subfolder cannot report
	// a path relative to the parent.
	effectiveOutputDir := outputDir
	// msgCh collects ALL incoming data channel messages, so the callback that
	// pion runs on its own goroutine feeds a sequential loop here.
	//
	// It comes from peer.Connection.Early() when the caller has one, and that is
	// the only correct source for a channel obtained from SetupAsReceiver: pion
	// ACKs the data channel and starts reading before the application is told
	// anything, so a handler registered here, at the top of the receive, can miss
	// the sender's first message. It is not late by much. It is late by enough.
	//
	// The fallback below is for callers that own the data channel themselves and
	// registered nothing, which in practice means the loopback tests.
	var msgCh <-chan webrtc.DataChannelMessage
	var done <-chan struct{}
	if opts.Messages != nil && opts.Closed != nil {
		msgCh, done = opts.Messages, opts.Closed
	} else {
		// done is closed when the data channel closes. We signal via a separate
		// channel instead of closing msgCh from OnClose: closing msgCh while the
		// OnMessage callback might still push would panic ("send on closed
		// channel"). The OnMessage send selects on done so it can never block or
		// panic after close.
		ch := make(chan webrtc.DataChannelMessage, 256)
		d := make(chan struct{})
		var closeOnce sync.Once
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			select {
			case ch <- msg:
			case <-d:
			}
		})
		dc.OnClose(func() {
			closeOnce.Do(func() { close(d) })
		})
		msgCh, done = ch, d
	}

	// Process messages sequentially
	var currentFile *os.File // the .part staging file the bytes are written to
	var currentInfo FileInfo
	var currentDisplayName string // displayText(currentInfo.FileName): every print, callback and error uses this, never the raw name
	var currentRel string         // the relative path the file is claimed under: safeJoin's result, checked by layer 1
	var currentBase string        // currentRel under effectiveOutputDir; the de-collision sequence starts here
	var currentDest string        // final path claimed for the file (see claimPart)
	var currentSavedName string   // FINAL on-disk name, relative to effectiveOutputDir (see Progress.SavedName)
	var bytesReceived int64
	var totalReceived int64
	var bar *progressbar.ProgressBar
	var start time.Time
	filesReceived := 0
	// Layer 2 state, read only when opts.Limits is set: every metadata frame
	// counts (E-37), the first one is what later ones must agree with, and
	// its announced total, recorded when the transfer is accepted, is what
	// the bytes actually received are held to (D-055).
	metadataFrames := 0
	var firstInfo FileInfo
	var approvedTotal int64
	// This side's reading of the selected pair, taken once when the transfer
	// is accepted and only with Limits.HostRelayCheck: no ICE restart exists,
	// so the pair does not change during a drop.
	relayVerdict := "unknown"
	// SHA-256 of the bytes written to the current .part, started fresh on every
	// claim so an abandoned file can never lend its digest to the next one.
	var currentHash hash.Hash
	verifiedCount := 0 // committed files whose sender digest was present and matched
	waitingForFirst := true
	// Where the de-collision scan for each base path stopped. Scoped to this
	// call so a long-lived desktop process does not carry numbering across
	// transfers into a directory the person may have emptied in between.
	hints := newNameHints(runtime.GOOS)

	// If the transfer is interrupted (peer disconnect, stall, or error) before
	// the "end" marker completes the current file, release the handle and
	// delete the .part staging file, freeing its claimed final name so a retry
	// can reuse it. Success is safe because the "end" handler closes and nils
	// currentFile before any return, so anything still non-nil here is a
	// staging file by definition; files that completed earlier in the batch
	// were renamed to their final names and are never touched. Close before
	// Remove (Windows refuses to delete an open file), and Remove is
	// best-effort so a sharing violation from an AV scanner never masks the
	// real transfer error. Directories created for folder transfers are left
	// in place.
	defer func() {
		if currentFile != nil {
			// discardPart, not a Close and Remove here: the unregister-then-Close
			// ordering is what keeps this from deleting another transfer's file,
			// and it is argued once, on the function.
			discardPart(currentFile)
		}
	}()

	// Stall watchdog: armed only while the loop is actually blocked on an
	// empty msgCh, so it measures exactly "no data for this long" and can
	// never fire while messages are flowing. The interactive accept prompt
	// runs synchronously inside the metadata case below, outside any select,
	// so a slow human can never trip it either.
	stallTimer := time.NewTimer(receiveIdleTimeout)
	defer stallTimer.Stop()

	for {
		// Prefer draining buffered messages over reacting to a close: a normal
		// transfer ends with the final "end" marker already queued in msgCh,
		// which must be processed even if OnClose has fired alongside it.
		var msg webrtc.DataChannelMessage
		select {
		case msg = <-msgCh:
		default:
			// Bare Reset without a Stop/drain is correct under the Go 1.23+
			// timer semantics this module's go directive activates; lowering
			// the directive (or GODEBUG=asynctimerchan=1) would let a stale
			// expiry misfire the very next select.
			if waitingForFirst {
				stallTimer.Reset(receiveIdleTimeout)
			} else {
				stallTimer.Reset(receiveStallTimeout)
			}
			select {
			case msg = <-msgCh:
			case <-done:
				// Channel closed before the transfer finished normally. A close
				// with no completed files is never success: the sender cancelled
				// or was blocked (for example by its relay size cap), so report
				// it instead of returning a false "saved" outcome.
				return closedError(currentFile, currentDisplayName, bytesReceived, currentInfo, filesReceived)
			case <-stallTimer.C:
				// If the close raced the timer, report the close: it is the
				// more precise diagnosis, and it keeps behavior identical to
				// the done case above.
				select {
				case <-done:
					return closedError(currentFile, currentDisplayName, bytesReceived, currentInfo, filesReceived)
				default:
				}
				// Phase-aware stall errors. Deliberately no protocol or
				// version phrasing: the "floe update" hint belongs to the
				// incompatible path only.
				switch {
				case waitingForFirst:
					return fmt.Errorf("connected, but no data arrived from the sender within %s", receiveIdleTimeout)
				case currentFile != nil:
					return fmt.Errorf("transfer stalled: no data for %s (%d of %d bytes of %q)",
						receiveStallTimeout, bytesReceived, currentInfo.FileSize, currentDisplayName)
				default:
					return fmt.Errorf("transfer stalled: no data for %s (%d of %d files received)",
						receiveStallTimeout, filesReceived, currentInfo.Total)
				}
			}
		}

		// A string is never file data (the `if msg.IsString { continue }` rule
		// below is what proves it), so a string past the control cap is not
		// something to write and not something to parse: it is a peer sending
		// prose where a control message belongs. Fail loudly rather than skip
		// it: skipping leaves the sender waiting on an ack that never comes and
		// this side to the stall watchdog, whereas returning lets the caller's
		// deferred Close reach the sender within a second. A BINARY frame of any
		// size is file data and never reaches classifyControl at all.
		//
		// What crosses the cap in practice is the metadata of a deep folder
		// path, so the frame carries path-too-long and a current sender shows
		// its fixed sentence. The reason is the one this frame has always
		// carried, for peers that print it.
		if msg.IsString && len(msg.Data) > controlMsgMax {
			detail := fmt.Sprintf("control message is %d bytes, limit %d", len(msg.Data), controlMsgMax)
			AbortWithCode(dc, localVer, CodePathTooLong, "receiver rejected the file description: "+detail, filesReceived)
			return fmt.Errorf("rejected the sender's control message: %d bytes, limit %d", len(msg.Data), controlMsgMax)
		}

		// Decide whether this is a Floe control message (metadata/end) or file
		// data, and decide it from the SCTP framing rather than from the bytes.
		//
		// Every Floe sender since v1.0.0 sends metadata and end with SendText
		// (a JS string through simple-peer on the browser side) and file chunks
		// with Send, so on this side a BINARY frame is file data, full stop.
		// Probing its bytes was the bug: a whole small file whose content is a
		// control-shaped JSON object, such as the 14 bytes {"type":"end"}, was
		// consumed as control and never written. Desktop's StartSendText makes
		// that a one-click send.
		//
		// This is a PROHIBITION as much as a decision: a future
		// sender-to-receiver control frame MUST go out as text, or it lands in
		// somebody's file. Receiver-to-sender frames are unaffected and stay
		// binary, because no file data travels that way.
		var msgType string
		var isControl bool
		if msg.IsString {
			msgType, isControl = classifyControl(msg.Data)
		}
		if isControl {
			switch msgType {

			case "incompatible":
				// The sender is stopping on purpose and said why. Until now this
				// was classified as control purely so it was never written as
				// file data, then dropped, so the reason it carries went
				// nowhere and this side reported a bare close instead.
				//
				// The Reason is peer prose headed for a terminal or a status
				// line, so it goes through the same display cap as every other
				// peer string.
				var incompat incompatibleMsg
				if err := json.Unmarshal(msg.Data, &incompat); err != nil {
					return fmt.Errorf("the sender stopped the transfer")
				}
				// Rebuilt locally, exactly as the sender does with the same frame.
				// compatErrorFromIncompatible prints the peer reason when the pv
				// ranges overlap, which is a deliberate abort, and rebuilds from
				// pv/pvMin with THIS surface update hint when they do not, so a
				// desktop receiver is never told to run a command it does not have.
				return fmt.Errorf("%s", compatErrorFromIncompatible(localVer, opts.UpdateHint, incompat))

			case "metadata":
				// A new file is starting
				info, err := parseMetadata(string(msg.Data))
				if err != nil {
					// classifyControl already proved this is a metadata object, so a failure
					// here is a sender whose numbers cannot be right (a negative size, a size
					// past 2^53). This used to `continue`, which left the sender waiting on an
					// ack that never came and this side to the stall watchdog. Returning lets
					// the caller's deferred Close reach the sender within a second.
					rejectDescription(dc, localVer, err.Error())
					return fmt.Errorf("rejected the sender's file description: %w", err)
				}
				metadataFrames++
				// A second metadata while a file is still open means the sender
				// abandoned the current file without an "end". Close and delete
				// the .part staging file before starting the next one, or the
				// handle leaks and the abandoned staging file lingers, keeping
				// its claimed final name blocked.
				//
				// A request link refuses it instead (E-37): replaying metadata
				// with fresh paths would otherwise build a folder tree per
				// frame. The deferred discard removes the open .part.
				if currentFile != nil {
					if opts.Limits != nil {
						return refuseLimit(dc, localVer, CodeOverApproved, CodeOverApproved.WireReason(), filesReceived)
					}
					discardPart(currentFile)
					currentFile = nil
				}
				currentInfo = info
				// The one display form of the name. safeJoin below derives the
				// on-disk name from the raw info.FileName under different rules
				// (Windows reserved characters, trailing trims, a length that is
				// a compatibility surface), so the two may differ; SavedName
				// carries the on-disk one.
				currentDisplayName = displayText(info.FileName, maxDisplayName)
				bytesReceived = 0

				// Layer 1, on every receiver and for every file, before the
				// Incoming box, OnIncoming, Decide and the prompt, so nobody is
				// asked about a file this side will refuse, and before MkdirAll,
				// so a refused path creates nothing. currentRel is relative to
				// whichever folder the claim lands in, which Decide may still
				// change; the claim below joins the two.
				currentRel = safeJoin("", info.FileName)
				// The name hook, request links only: it renames the leaf and
				// strips class IDs, so it runs before the depth and length
				// checks, which then measure the name that will be claimed.
				if opts.Limits != nil && opts.Limits.BlockShellTypes {
					currentRel, _ = blockShellTypes(currentRel)
				}
				if code, reason := checkPathShape(info.FileName, currentRel); code != "" {
					return refuseLimit(dc, localVer, code, reason, filesReceived)
				}
				// A volume that cannot say counts as no known maximum.
				volumeMax, err := volumeMaxFn(effectiveOutputDir)
				if err != nil {
					volumeMax = 0
				}
				if code, reason := checkAnnouncedSize(info.FileSize, volumeMax); code != "" {
					return refuseLimit(dc, localVer, code, reason, filesReceived)
				}
				// Layer 2's first-metadata checks need no folder, so they run
				// here too, before anyone is asked.
				if opts.Limits != nil && waitingForFirst {
					if code, reason := checkFirstMetadata(info, opts.Limits); code != "" {
						return refuseLimit(dc, localVer, code, reason, filesReceived)
					}
				}

				// On first file: check compat, show summary, and optionally prompt
				if waitingForFirst {
					waitingForFirst = false
					start = time.Now()
					firstInfo = info

					// Protocol compatibility check - before creating any files or
					// prompting the user. Send "incompatible" so the sender fails
					// fast with a clear message rather than waiting for an ack.
					ok, localTooOld := CheckCompat(MinProtocolVersion, ProtocolVersion, info.PvMin, info.Pv)
					if !ok {
						errMsg := compatErrorMessage(localTooOld, localVer, info.Ver,
							MinProtocolVersion, ProtocolVersion, info.PvMin, info.Pv, opts.UpdateHint)
						peerErrMsg := peerCompatErrorMessage(localTooOld, localVer, info.Ver,
							MinProtocolVersion, ProtocolVersion, info.PvMin, info.Pv)
						// Through abortReason for the flush. This is the path #284
						// was filed about, where the frame was lost in 6 of 6 rounds.
						abortReason(dc, localVer, peerErrMsg, false)
						return fmt.Errorf("%s", errMsg)
					}

					// Optional informational note when release versions differ
					if info.Ver != "" && localVer != "" && info.Ver != localVer {
						fmt.Printf("  Peer version: %s\n", displayText(info.Ver, maxDisplayVer))
					}

					var incomingLabel string
					switch {
					case info.Total == 1:
						incomingLabel = currentDisplayName + " · " + formatBytes(info.FileSize)
					case info.TotalBytes > 0:
						incomingLabel = pluralize(info.Total, "file") + " · " + formatBytes(info.TotalBytes)
					default:
						incomingLabel = pluralize(info.Total, "file")
					}
					fmt.Println()
					PrintBox([][2]string{{"Incoming", incomingLabel}})
					fmt.Println()

					tb := info.TotalBytes
					if info.Total == 1 && tb == 0 {
						tb = info.FileSize // legacy sender: the single file's size is still known
					}
					// Built once, so what the preview showed is exactly what the
					// decision below is asked about. Every field is a validated
					// number or the display form of the name.
					incoming := IncomingInfo{Files: info.Total, TotalBytes: tb, FirstName: currentDisplayName, FirstSize: info.FileSize}
					if opts.OnIncoming != nil {
						opts.OnIncoming(incoming)
					}

					// The one place a caller's callback can hold this loop for
					// minutes: a person is deciding. Neither watchdog is armed
					// while it runs (they are armed only around an empty msgCh,
					// see the stall timer above), exactly as neither is armed for
					// the terminal prompt below.
					if opts.Decide != nil {
						d := opts.Decide(incoming)
						// The sender may have given up and closed while the
						// person was deciding. Ask before acting on the answer:
						// everything past this block claims a name, creates a
						// directory and a staging file and acks, and doing that
						// for a peer that is gone leaves all three behind and
						// reports a mid-transfer close that never happened.
						// Best effort by construction: a close that lands
						// between this check and openPart still claims a
						// .part and still reports closedError, the same race
						// every receive has always had. What changed is its
						// size, from the whole decision window down to a few
						// instructions.
						select {
						case <-done:
							return ErrSenderLeft
						default:
						}
						switch d.Kind {
						case DecisionAccept:
							// The first line allowed to name the accepted folder.
							// A caller that creates it at this moment, rather
							// than before asking, leaves nothing behind when the
							// answer is no.
							if d.OutputDir != "" {
								effectiveOutputDir = d.OutputDir
							}
						case DecisionRefuse:
							code := d.Code
							if code == "" {
								code = CodeStopped
							}
							// The frame first and the close second, in that
							// order: AbortWithCode flushes until the frame is
							// out, polling at 10 ms and bounded by
							// controlFlushTimeout (2 s), and a refusal reaches a
							// Go sender one tick later (measured 1.0 ms, with the
							// buffer already empty), while a bare close leaves it
							// with generic closed-while-waiting text and no
							// reason at all. The saved count is the constant 0,
							// not filesReceived: this is the first metadata, so
							// nothing has been committed and the constant says so
							// at a glance.
							AbortWithCode(dc, localVer, code, code.WireReason(), 0)
							dc.Close()
							return &RefusedError{Code: code}
						default:
							// DecisionDecline, and any Kind this build does not
							// know: both take the one path that creates nothing
							// and still names a reason the sender can act on.
							// Same frame-then-close order, for the same reason.
							AbortWithCode(dc, localVer, CodeDeclined, CodeDeclined.WireReason(), 0)
							dc.Close()
							return ErrDeclined
						}
					}

					// A Decide has already answered for this side, so asking a
					// second time at the terminal would ask the wrong person.
					if opts.Decide == nil && !autoAccept {
						fmt.Print("  Accept? [Y/n] ")
						var answer string
						fmt.Scanln(&answer)
						answer = strings.TrimSpace(strings.ToLower(answer))
						if answer == "n" || answer == "no" {
							dc.Close()
							return fmt.Errorf("transfer declined")
						}
					}

					// Accepted, by Decide, the prompt or autoAccept: this is
					// the total the rest of the drop is held to.
					approvedTotal = info.TotalBytes
					if opts.Limits != nil && opts.Limits.HostRelayCheck {
						relayVerdict = hostRelayVerdict(dc)
					}
				}

				// Layer 2 at every metadata, immediately before the claim:
				// both totals and the index agree with the first metadata,
				// the frames stay within MaxFiles, and the folder the file
				// lands in has room for it plus the reserve. After Decide,
				// because the free space is the accepted folder's.
				if opts.Limits != nil {
					free, err := diskFreeFn(effectiveOutputDir)
					if err != nil {
						free = -1
					}
					if code, reason := checkEveryMetadata(info, firstInfo, filesReceived, metadataFrames, opts.Limits, free); code != "" {
						return refuseLimit(dc, localVer, code, reason, filesReceived)
					}
					// On a relay this side confirmed, a file that would take
					// the drop past the cap is refused before its ack.
					if opts.Limits.HostRelayCheck {
						if err := checkRelayGate(relayVerdict, totalReceived+info.FileSize); err != nil {
							return refuseRelay(dc, localVer, filesReceived, err)
						}
					}
				}

				// Claim a final name and open its .part staging file (create
				// parent dirs for folder transfers first). Bytes go to the
				// staging file; the final name is taken only by the rename in
				// the "end" handler, so a kill at any moment leaves nothing on
				// disk that looks complete. Nothing in this arm above this line
				// creates anything on disk, and every path and limit check is
				// above it.
				// A failure here, or on the handle just below, is this side's
				// own disk refusing after the sender was accepted. It used to
				// return the raw OS error and send nothing, so the sender waited
				// out its ack deadline; refuseWrite names it on the wire.
				currentBase = filepath.Join(effectiveOutputDir, currentRel)
				if err := os.MkdirAll(filepath.Dir(currentBase), 0755); err != nil {
					return refuseWrite(dc, localVer, filesReceived, true, fmt.Errorf("cannot create directory: %w", err))
				}
				currentFile, currentDest, err = openPart(currentBase, hints)
				if err != nil {
					return refuseWrite(dc, localVer, filesReceived, true, fmt.Errorf("cannot create file %s: %w", currentBase, err))
				}
				registerPartial(currentFile)
				currentHash = sha256.New()
				// Refuse anything that is not a regular file. claimPart already
				// Lstats each final-name candidate and commitPart stats the
				// placeholder it creates, so this is defense in depth on the
				// staging handle itself: cheap, and it keeps the guarantee even
				// if those checks are ever reshaped.
				// A failed Stat is not treated as a failure: the file is already
				// open and writable, and refusing on a stat hiccup would break a
				// transfer that would otherwise succeed.
				if st, statErr := currentFile.Stat(); statErr == nil && !st.Mode().IsRegular() {
					// Read the name before discarding: discardPart closes the handle.
					name := currentFile.Name()
					discardPart(currentFile)
					currentFile = nil
					return refuseWrite(dc, localVer, filesReceived, true,
						fmt.Errorf("refusing to write %s: not a regular file (%s)", name, st.Mode()))
				}
				// The FINAL name claimed for this file, which differs from the
				// sender's whenever claimPart de-collided or safeJoin sanitized.
				// Everything user-facing below reports this name, never the
				// .part staging name, so progress lines and history read as the
				// file the user will end up with. The fallback is the claimed
				// path's own base name, never the sender's string: Rel fails
				// only when the two paths are on different volumes, and the
				// name is still whatever claimPart wrote.
				currentSavedName = filepath.ToSlash(filepath.Base(currentDest))
				if rel, relErr := filepath.Rel(effectiveOutputDir, currentDest); relErr == nil {
					currentSavedName = filepath.ToSlash(rel)
				}

				// Progress bar for this file (CLI). GUIs get callback updates instead.
				if onProgress == nil {
					bar = newProgressBar(info.FileSize, info.Index, info.Total, currentSavedName)
				}

				// Send ack as BINARY with protocol version fields so the sender
				// can verify compat from its side and show the optional peer-version
				// note. The browser checks data.byteLength before decoding, which is
				// only defined on ArrayBuffer/Buffer, not strings.
				// The end handler's SHA-256 covers only bytes written after claimPart,
				// so a future non-zero offset must re-hash the prefix or skip
				// verification.
				ack := map[string]interface{}{
					"type":   "ack",
					"id":     info.ID,
					"offset": 0,
					"pv":     ProtocolVersion,
					"pvMin":  MinProtocolVersion,
				}
				if localVer != "" {
					ack["ver"] = localVer
				}
				ackJSON, _ := json.Marshal(ack)
				dc.Send([]byte(ackJSON))

			case "end":
				// Current file is complete
				if currentFile != nil {
					staged := currentFile
					partPath := staged.Name()
					// Unregister FIRST: from this line an abandon can no longer
					// touch this file. Then the flush and close double as the
					// OWNERSHIP PROOF for the path: AbandonPartials closes a
					// registered file before removing its path, so if our own
					// Sync and Close both succeed, no abandon ever touched the
					// handle, the .part at partPath is still OUR file, and the
					// rename below cannot steal a path that a newer transfer
					// re-claimed after an abandon freed it (a torture test
					// proved exactly that theft when the commit trusted the
					// path string alone).
					unregisterPartial(staged)
					syncErr := syncPart(staged)
					closeErr := staged.Close()
					currentFile = nil
					fmt.Println()
					// os.ErrClosed is the abandon's fingerprint: AbandonPartials
					// closed the shared handle before we unregistered, so our
					// Sync and Close find it already closed. The transfer was
					// abandoned mid-flight and the path may already belong to a
					// newer transfer, so leave it alone entirely and report the
					// abort, exactly as before.
					if errors.Is(syncErr, os.ErrClosed) || errors.Is(closeErr, os.ErrClosed) {
						return fmt.Errorf("transfer abandoned while completing %q", currentSavedName)
					}
					// Any other error is our own handle failing to flush or
					// close: a real I/O failure (a network share, a USB bridge,
					// a delayed write error), and the path is still ours. This
					// used to share the abandon branch, which left the .part on
					// disk forever and told the sender nothing. Remove it (best
					// effort: a sharing lock leaves a .part, never a final name)
					// and say why. The reason names no surface and no path, and
					// a full drive is named as such (a Sync can fail with it too).
					if syncErr != nil || closeErr != nil {
						_ = os.Remove(partPath)
						cause := syncErr
						if cause == nil {
							cause = closeErr
						}
						return refuseWrite(dc, localVer, filesReceived, false, cause)
					}

					// Integrity guard: a short byte count means the transfer was
					// truncated (e.g. the sender closed early). Fail loudly rather
					// than leave a corrupt file that looks complete. The handle is
					// already closed and nil'd above (required before Remove on
					// Windows), so the interrupt cleanup cannot see this truncated
					// staging file; delete it here.
					if bytesReceived != currentInfo.FileSize {
						_ = os.Remove(partPath)
						detail := fmt.Sprintf("incomplete file %q: received %d of %d bytes",
							currentDisplayName, bytesReceived, currentInfo.FileSize)
						// Without this the sender simply stops being acked. With
						// more files to send it waits out the full 120 s ack
						// deadline and then reports a timeout, which is the wrong
						// cause two minutes late.
						abortReason(dc, localVer, "receiver discarded a file: "+detail, false)
						return fmt.Errorf("%s", detail)
					}

					// SHA-256, when the sender sent one. After the byte-count guard,
					// so a short file still reports "incomplete file", and before
					// MOTW and the rename, so a file that fails never exists under
					// its final name. The digest covers the bytes as they were
					// written and is never re-read from disk. Not a secret, so a
					// plain comparison; the peer's value is compared and dropped,
					// never printed, logged or stored.
					sha, shaErr := parseEnd(msg.Data)
					if shaErr == nil && sha != "" && sha != hex.EncodeToString(currentHash.Sum(nil)) {
						shaErr = errSHA256Mismatch
					}
					if shaErr != nil {
						_ = os.Remove(partPath)
						reason := "receiver discarded a file because its SHA-256 did not match"
						if errors.Is(shaErr, errSHA256Unreadable) {
							reason = "receiver discarded a file because the sender's SHA-256 was not readable"
						}
						AbortWithCode(dc, localVer, CodeHashMismatch, reason, filesReceived)
						return &RefusedError{Code: CodeHashMismatch, Saved: filesReceived, Err: shaErr}
					}
					matched := sha != ""

					// Mark the file as internet-sourced (Windows MOTW) so
					// SmartScreen / Office Protected View apply when it is opened,
					// like a browser download. Best-effort and Windows-only.
					// Applied to the .part BEFORE the rename: the Zone.Identifier
					// stream travels with a same-volume rename, so the final name
					// never exists for even an instant without its zone tag.
					_ = applyMOTW(partPath)

					// Publish the verified bytes at the final name. On failure the
					// staging file is deliberately left in place: the bytes are
					// complete and verified, and deleting them over a transient
					// AV lock would be data loss.
					finalPath, commitErr := commitPart(partPath, currentDest, currentBase)
					if commitErr != nil {
						return fmt.Errorf("received %q in full but could not finish saving it: %w",
							currentSavedName, commitErr)
					}

					// External interference only: something claimed the final name
					// between our claim and the commit, so the file landed under a
					// numbered sibling. Correct everything that reported the name.
					if rel, relErr := filepath.Rel(effectiveOutputDir, finalPath); relErr == nil {
						if s := filepath.ToSlash(rel); s != currentSavedName {
							currentSavedName = s
							if onProgress != nil {
								onProgress(Progress{
									FileName:   currentDisplayName,
									FileIndex:  currentInfo.Index,
									FileCount:  currentInfo.Total,
									FileBytes:  bytesReceived,
									FileSize:   currentInfo.FileSize,
									TotalBytes: totalReceived,
									GrandTotal: currentInfo.TotalBytes,
									SavedName:  currentSavedName,
								})
							} else {
								fmt.Printf("  Saved as %s\n", currentSavedName)
							}
						}
					}

					filesReceived++
					// Counted only after the commit, so verifiedCount can never
					// exceed filesReceived: a commit failure above returns with the
					// verified .part left in place and nothing counted.
					if matched {
						verifiedCount++
					}
					if opts.OnFileDone != nil {
						opts.OnFileDone(FileDone{SavedName: currentSavedName, Bytes: bytesReceived, Verified: matched})
					}
					if filesReceived >= currentInfo.Total {
						elapsed := time.Since(start)
						timeVal := formatDuration(elapsed)
						if spd := formatSpeed(float64(totalReceived) / elapsed.Seconds()); spd != "" {
							timeVal += " · avg " + spd
						}
						rows := [][2]string{
							{"Received", fmt.Sprintf("%s (%s)", pluralize(filesReceived, "file"), formatBytes(totalReceived))},
						}
						// Only when every file matched. "Verified" is as wide as
						// "Received" and "Saved to", so the box keeps its width, and
						// no digest is ever printed.
						if verifiedCount == filesReceived && filesReceived > 0 {
							rows = append(rows, [2]string{"Verified", "SHA-256 matched"})
						}
						rows = append(rows, [2]string{"Time", timeVal}, [2]string{"Saved to", effectiveOutputDir})
						printSummary(rows)

						// Tell the sender all bytes are written and verified so it
						// can close cleanly without relying on SCTP buffer accounting.
						// Sent as binary so the browser (which checks byteLength) can
						// classify it and ignore it; CLI senders consume it explicitly.
						// verified is always present: 0 means this receiver checks
						// hashes and no file carried one.
						receivedMsg, _ := json.Marshal(map[string]interface{}{"type": "received", "verified": verifiedCount})
						dc.Send([]byte(receivedMsg))

						// Wait for the sender to close the channel (or a short grace
						// period) before returning. This keeps our SCTP/DTLS alive
						// long enough for the "received" SACK to reach the sender —
						// tearing down immediately would race it.
						select {
						case <-done:
						case <-time.After(5 * time.Second):
						}

						// Report total bytes to the global stats counter. Called
						// synchronously AFTER the grace wait so the program does not
						// exit before the HTTP POST completes. reportBytesToServer
						// has its own 5 s timeout and is fire-and-forget on error.
						reportBytesToServer(serverURL, totalReceived)
						return nil
					}
				}
			}
			continue
		}

		// A string that was not a recognized control message is never file data.
		if msg.IsString {
			continue
		}

		// Binary chunk — write directly to disk
		if currentFile == nil {
			continue // no file open yet; shouldn't happen in normal flow
		}
		// Hold the sender to the size it announced, frame by frame. The "end"
		// handler already refuses a byte count that differs, but only once
		// every byte has been written, so a sender that simply never stops
		// could fill the disk first. Failing on the first frame that would
		// cross the line bounds the damage to the announced size, and the
		// deferred cleanup removes the .part.
		if bytesReceived+int64(len(msg.Data)) > currentInfo.FileSize {
			detail := fmt.Sprintf("sender exceeded the announced size of %q", currentDisplayName)
			abortReason(dc, localVer, "receiver stopped the transfer: "+detail, false)
			return fmt.Errorf("%s", detail)
		}
		// A request link also holds the whole drop to the total that was
		// accepted, counting bytes that arrived rather than any announced
		// size, so files that each stay inside their own size cannot add up
		// past it (VR2-05). The deferred cleanup removes the .part.
		if opts.Limits != nil {
			if code, reason := checkFrame(totalReceived, len(msg.Data), approvedTotal); code != "" {
				return refuseLimit(dc, localVer, code, reason, filesReceived)
			}
			if opts.Limits.HostRelayCheck {
				if err := relayFrameCheck(relayVerdict, totalReceived, len(msg.Data)); err != nil {
					return refuseRelay(dc, localVer, filesReceived, err)
				}
			}
		}
		// A failed write used to return the raw OS error with nothing on the
		// wire. The .part stays open here: the deferred discard removes it once
		// the refusal has been flushed to the sender.
		n, err := writePart(currentFile, msg.Data)
		if err != nil {
			return refuseWrite(dc, localVer, filesReceived, false, err)
		}
		currentHash.Write(msg.Data[:n]) // only what reached the file
		bytesReceived += int64(n)
		totalReceived += int64(n)
		if bar != nil {
			bar.Add(n)
		} else {
			onProgress(Progress{
				FileName:   currentDisplayName,
				FileIndex:  currentInfo.Index,
				FileCount:  currentInfo.Total,
				FileBytes:  bytesReceived,
				FileSize:   currentInfo.FileSize,
				TotalBytes: totalReceived,
				GrandTotal: currentInfo.TotalBytes,
				SavedName:  currentSavedName,
			})
		}
	}
}

// closedError judges a closed connection: nil when everything the sender
// announced actually arrived, and the most specific diagnosis otherwise.
// Two verbatim copies of this ladder lived twenty lines apart, one in the
// done case and one in the stall timer's race-with-close check, which is two
// places to get "was this a clean finish?" wrong.
func closedError(currentFile *os.File, displayName string, bytesReceived int64, info FileInfo, filesReceived int) error {
	if currentFile != nil {
		return fmt.Errorf("connection closed mid-transfer: %s (%d of %d bytes)",
			displayName, bytesReceived, info.FileSize)
	}
	if filesReceived == 0 {
		return fmt.Errorf("connection closed before any file arrived (the sender canceled, or the transfer was blocked)")
	}
	if info.Total > 0 && filesReceived < info.Total {
		return fmt.Errorf("connection closed after %d of %d files", filesReceived, info.Total)
	}
	return nil
}
