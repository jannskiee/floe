package main

// Send mode: a CLI-shaped sender whose end frame can carry a digest that does
// not match what it sent. The engine sender is untouched by this file and has
// no flag, build tag or hook for it, which is the point: the corrupt digest
// exists only here, in a binary that no release builds.
//
// The loop is the protocol's own order, written out by hand rather than called
// through transfer.SendFiles, because SendFiles has no way to lie and must not
// gain one: TEXT metadata, the ack read off the early channel, BINARY chunks
// with a buffered-amount wait, then a TEXT end frame.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jannskiee/floe/cli/engine/ice"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/pion/webrtc/v4"
)

const (
	sendChunk     = 64 * 1024
	sendHighWater = 8 * 1024 * 1024
	sendLowWater  = 4 * 1024 * 1024
)

// hashMode says what the end frame's digest should be.
type hashMode int

const (
	hashReal hashMode = iota
	// hashCorrupt changes the first hex digit, so the digest is well formed and
	// cannot match.
	hashCorrupt
	// hashMalformed upper-cases the digest, which the wire format forbids.
	hashMalformed
)

func runSend(ev *events, args []string) {
	fs := flag.NewFlagSet("send", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	server := fs.String("server", "http://localhost:3001", "signaling server base URL")
	web := fs.String("web", "http://localhost:3000", "web app base URL, for the printed link")
	room := fs.String("room", "", "room UUID (generated when empty)")
	corrupt := fs.Bool("corrupt-hash", false, "change one hex digit of each file's digest")
	malformed := fs.Bool("malformed-hash", false, "send each file's digest upper-cased")
	wait := fs.Duration("refusal-wait", 10*time.Second, "how long to wait for the peer's refusal")
	timeout := fs.Duration("timeout", 2*time.Minute, "overall deadline for the whole run")
	if err := fs.Parse(args); err != nil || fs.NArg() == 0 || *timeout <= 0 || *wait <= 0 {
		ev.usage()
	}
	if *corrupt && *malformed {
		ev.usage()
	}
	mode := hashReal
	if *corrupt {
		mode = hashCorrupt
	} else if *malformed {
		mode = hashMalformed
	}
	paths := fs.Args()
	if *room == "" {
		*room = uuid.New().String()
	} else if _, err := uuid.Parse(*room); err != nil {
		ev.usage()
	}

	sizes := make([]int64, len(paths))
	var totalBytes int64
	for i, p := range paths {
		info, err := os.Stat(p)
		if err != nil || info.IsDir() {
			ev.fail("input")
		}
		sizes[i] = info.Size()
		totalBytes += info.Size()
	}

	watchdog := time.AfterFunc(*timeout, func() { ev.fail("timeout") })

	sc, err := signaling.Connect(*server)
	if err != nil {
		ev.fail("connect")
	}
	defer sc.Close()
	if err := sc.JoinRoom(*room); err != nil {
		ev.fail("join")
	}
	select {
	case role := <-sc.Role:
		ev.emit(map[string]interface{}{"event": "joined", "role": role, "roomId": *room})
	case <-sc.RoomFull:
		ev.fail("role")
	case <-sc.Errors:
		ev.fail("role")
	case <-sc.PeerLeft:
		ev.fail("role")
	}
	// The link the other side opens. Only the room id the caller passed or this
	// process generated goes into it.
	ev.emit(map[string]interface{}{"event": "link", "link": strings.TrimRight(*web, "/") + "/#room=" + *room})

	select {
	case <-sc.PeerConnected:
	case <-sc.PeerLeft:
		ev.fail("peer-wait")
	}

	servers, _, err := ice.FetchDetail(*server)
	if err != nil {
		ev.fail("ice")
	}
	conn, err := peer.New(servers, sc)
	if err != nil {
		ev.fail("peer")
	}
	defer conn.Close()
	dc, err := conn.SetupAsSender()
	if err != nil {
		ev.fail("setup")
	}
	ev.emit(map[string]interface{}{"event": "channel-open"})
	early := conn.Early()

	for i, path := range paths {
		if !sendOneFile(ev, dc, early.Msgs, early.Closed, path, sizes[i], i+1, len(paths), totalBytes, mode) {
			return
		}
	}

	// The refusal the corrupt digest is supposed to draw. Waiting is the whole
	// oracle: a receiver that accepted a wrong digest would say nothing here.
	code := waitForRefusal(early.Msgs, early.Closed, *wait)
	watchdog.Stop()
	ev.emit(map[string]interface{}{"event": "peer-refused", "code": code})
	conn.Close()
	sc.Close()
	if code == "none" {
		ev.exit(1)
	}
	ev.exit(0)
}

// sendOneFile runs the protocol for one file and reports whether it finished.
func sendOneFile(ev *events, dc *webrtc.DataChannel, msgs <-chan webrtc.DataChannelMessage, closed <-chan struct{}, path string, size int64, index, total int, totalBytes int64, mode hashMode) bool {
	f, err := os.Open(path)
	if err != nil {
		ev.fail("open")
	}
	defer f.Close()

	id := uuid.New().String()
	meta := map[string]interface{}{
		"type": "metadata", "id": id, "fileName": filepath.Base(path),
		"fileSize": size, "index": index, "total": total, "totalBytes": totalBytes,
		"pv": 1, "pvMin": 1, "ver": "e2ehost",
	}
	metaJSON, _ := json.Marshal(meta)
	if err := dc.SendText(string(metaJSON)); err != nil {
		ev.fail("metadata")
	}

	// The ack, read off the early channel the same way the engine reads it.
	deadline := time.After(2 * time.Minute)
	for {
		select {
		case m := <-msgs:
			// Not gated on m.IsString: pion reports the Go receiver's control
			// frames as binary, and the engine's own reader goes by shape too.
			if frame, ok := controlFrame(m.Data); ok {
				if frame.Type == "ack" && frame.ID == id {
					goto acked
				}
				if frame.Type == "incompatible" {
					ev.emit(map[string]interface{}{"event": "peer-refused", "code": refusalCode(m.Data)})
					ev.exit(0)
				}
			}
		case <-closed:
			ev.fail("closed")
		case <-deadline:
			ev.fail("ack")
		}
	}
acked:

	hasher := sha256.New()
	buf := make([]byte, sendChunk)
	for {
		n, readErr := f.Read(buf)
		if n > 0 {
			for dc.BufferedAmount() >= sendHighWater {
				time.Sleep(20 * time.Millisecond)
				if dc.BufferedAmount() < sendLowWater {
					break
				}
			}
			if err := dc.Send(buf[:n]); err != nil {
				ev.fail("chunk")
			}
			hasher.Write(buf[:n])
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			ev.fail("read")
		}
	}

	digest := hex.EncodeToString(hasher.Sum(nil))
	switch mode {
	case hashCorrupt:
		digest = flipFirstHexDigit(digest)
	case hashMalformed:
		digest = strings.ToUpper(digest)
	}
	// Built by hand so the field order matches the engine's frame exactly, which
	// is what the audit's hashbad cells match on.
	end := `{"type":"end","sha256":"` + digest + `"}`
	if err := dc.SendText(end); err != nil {
		ev.fail("end")
	}
	return true
}

// controlFrame decodes a small JSON object off the wire. A file chunk is never
// one: the check is the frame's own shape, the same way the engine's
// classifyControl reads it, and a big frame is never parsed at all.
func controlFrame(raw []byte) (struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}, bool) {
	var frame struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	if len(raw) == 0 || len(raw) > 4096 || raw[0] != '{' {
		return frame, false
	}
	if err := json.Unmarshal(raw, &frame); err != nil || frame.Type == "" {
		return frame, false
	}
	return frame, true
}

// flipFirstHexDigit returns the digest with its first hex digit changed, so it
// stays 64 lowercase hex characters and cannot match the bytes sent.
func flipFirstHexDigit(digest string) string {
	if digest == "" {
		return digest
	}
	first := "0"
	if digest[0] == '0' {
		first = "1"
	}
	return first + digest[1:]
}

// refusalCode reads the peer's code off an incompatible frame, mapping anything
// outside the closed set to "other" so the harness never echoes the peer's own
// words.
func refusalCode(raw []byte) string {
	var frame struct {
		Type string `json:"type"`
		Code string `json:"code"`
	}
	if err := json.Unmarshal(raw, &frame); err != nil || frame.Type != "incompatible" {
		return "other"
	}
	switch frame.Code {
	case "hash-mismatch", "write-failed":
		return frame.Code
	default:
		return "other"
	}
}

// waitForRefusal returns the peer's refusal code, "closed" when the channel
// went away first, or "none" when the wait ran out.
func waitForRefusal(msgs <-chan webrtc.DataChannelMessage, closed <-chan struct{}, wait time.Duration) string {
	deadline := time.After(wait)
	for {
		select {
		case m := <-msgs:
			if frame, ok := controlFrame(m.Data); ok && frame.Type == "incompatible" {
				return refusalCode(m.Data)
			}
		case <-closed:
			return "closed"
		case <-deadline:
			return "none"
		}
	}
}
