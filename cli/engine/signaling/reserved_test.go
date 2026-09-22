package signaling

// Fake-server tests for the reserved-room half of the client (S1-ENG-07):
// the host join with a token and its typed answers, the visitor join, the
// three control frames, liveness, Down, and the decoder's tolerance for
// frames it does not know. Nothing here talks to a real server.
//
// Tokens are compared as SHA-256 digests and never printed, test tokens
// included; a frame that carries one is shown with the token replaced.

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// fakeServer upgrades one connection and runs handle on it. When handle
// returns, the server keeps reading and discarding until the client goes
// away, so the socket stays open for as long as the test needs it (unlike
// testServer, which holds it for a fixed two seconds). handle runs on the
// server's goroutine: it reports through channels, never through t.Fatal.
func fakeServer(t *testing.T, handle func(*websocket.Conn)) *httptest.Server {
	t.Helper()
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws" {
			http.NotFound(w, r)
			return
		}
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		handle(conn)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// answerServer reads the client's first frame, hands it to the test, then
// writes answer (nothing when answer is empty, and a close when it is
// "close").
func answerServer(t *testing.T, answer string) (*httptest.Server, <-chan []byte) {
	t.Helper()
	frames := make(chan []byte, 8)
	srv := fakeServer(t, func(conn *websocket.Conn) {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		frames <- raw
		switch answer {
		case "":
		case "close":
			_ = conn.Close()
		default:
			_ = conn.WriteMessage(websocket.TextMessage, []byte(answer))
		}
	})
	return srv, frames
}

// wireEnd ends every frame this client writes: gorilla's WriteJSON encodes
// through a json.Encoder, which appends a newline, as it did for every frame
// the client has ever sent. The byte-exact frame checks include it.
const wireEnd = "\n"

// tokenPair makes a host token and the room id it derives.
func tokenPair(t *testing.T) (hostToken, roomID string) {
	t.Helper()
	tok, err := NewHostToken()
	if err != nil {
		t.Fatalf("NewHostToken: %v", err)
	}
	return tok, RoomIDFromToken(tok)
}

// redact replaces the token in b for a failure message.
func redact(b []byte, hostToken string) string {
	return strings.ReplaceAll(string(b), hostToken, "<token>")
}

// frameWithin waits for the server to hand over a frame.
func frameWithin(t *testing.T, frames <-chan []byte, d time.Duration) []byte {
	t.Helper()
	select {
	case f := <-frames:
		return f
	case <-time.After(d):
		t.Fatal("the fake server received no frame")
		return nil
	}
}

// shrinkReplyTimeout sets replyTimeout for one test after pinning its default.
func shrinkReplyTimeout(t *testing.T, d time.Duration) {
	t.Helper()
	if replyTimeout != 10*time.Second {
		t.Fatalf("replyTimeout = %v, want the card's 10s", replyTimeout)
	}
	replyTimeout = d
	t.Cleanup(func() { replyTimeout = 10 * time.Second })
}

// Every answer the server can give a token host (spec 04 5.5), mapped to its
// typed result. The join frame itself is pinned byte for byte, compared by
// digest because it carries the token.
func TestJoinRoomWithTokenTypedResults(t *testing.T) {
	cases := []struct {
		name    string
		answer  string
		want    HostJoinResult
		wantErr bool
	}{
		{"room-joined host", `{"type":"room-joined","role":"host"}`, HostJoined, false},
		{"refused disabled", `{"type":"refused","code":"disabled"}`, HostRefusedDisabled, false},
		{"refused limited", `{"type":"refused","code":"limited"}`, HostRefusedLimited, false},
		{"refused future-code", `{"type":"refused","code":"future-code"}`, HostRefusedUnknown, false},
		{"refused without a code", `{"type":"refused"}`, HostRefusedUnknown, false},
		{"room-full", `{"type":"room-full"}`, HostRoomFull, false},
		{"error Invalid host token", `{"type":"error","message":"Invalid host token"}`, HostInvalidToken, false},
		{"error Invalid room ID", `{"type":"error","message":"Invalid room ID"}`, HostInvalidRoom, false},
		{"error with another message", `{"type":"error","message":"something else"}`, HostRefusedUnknown, false},
		{"socket closes", "close", HostDown, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tok, room := tokenPair(t)
			srv, frames := answerServer(t, tc.answer)
			c := dial(t, srv)

			got, err := c.JoinRoomWithToken(room, tok)
			if got != tc.want {
				t.Fatalf("result = %v, want %v (err %v)", got, tc.want, err)
			}
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, want an error: %v", err, tc.wantErr)
			}
			if err != nil && strings.Contains(err.Error(), tok) {
				t.Fatal("the error text carries the host token")
			}
			if strings.Contains(got.String(), tok) {
				t.Fatal("the result's String carries the host token")
			}

			want := []byte(`{"type":"join-room","roomId":"` + room + `","hostToken":"` + tok + `"}` + wireEnd)
			frame := frameWithin(t, frames, 3*time.Second)
			if sha256.Sum256(frame) != sha256.Sum256(want) {
				t.Fatalf("join frame = %s, want %s", redact(frame, tok), redact(want, tok))
			}
		})
	}
}

// E-59: a server from before reserved rooms treats a token join as a plain
// join and seats the socket by join order, answering room-joined with role
// sender (or receiver). That is the only negative signal it gives, so any
// role but host must abort, typed, and never read as joined.
func TestJoinRoomWithTokenOldServerRoleAborts(t *testing.T) {
	for _, role := range []string{"sender", "receiver", "visitor", "", "HOST", "host "} {
		t.Run("role "+role, func(t *testing.T) {
			tok, room := tokenPair(t)
			answer, _ := json.Marshal(map[string]string{"type": "room-joined", "role": role})
			srv, _ := answerServer(t, string(answer))
			c := dial(t, srv)

			got, err := c.JoinRoomWithToken(room, tok)
			if got != HostOldServer {
				t.Fatalf("result = %v, want %v", got, HostOldServer)
			}
			if !errors.Is(err, ErrOldServer) {
				t.Fatalf("err = %v, want ErrOldServer", err)
			}
		})
	}
}

// A server that never answers (an old server ignoring an unknown field
// cannot, but a wedged one can) ends in a typed timeout after replyTimeout,
// shrunk here from its 10 s.
func TestJoinRoomWithTokenNoReplyIn10sIsTimeout(t *testing.T) {
	shrinkReplyTimeout(t, 200*time.Millisecond)
	tok, room := tokenPair(t)
	srv, _ := answerServer(t, "")
	c := dial(t, srv)

	start := time.Now()
	got, err := c.JoinRoomWithToken(room, tok)
	elapsed := time.Since(start)
	if got != HostTimeout || err == nil {
		t.Fatalf("result = %v, err = %v; want %v and an error", got, err, HostTimeout)
	}
	if elapsed < 150*time.Millisecond || elapsed > 3*time.Second {
		t.Fatalf("timed out after %v, want about the shrunk 200ms", elapsed)
	}
	if strings.Contains(err.Error(), tok) {
		t.Fatal("the error text carries the host token")
	}
}

// The local derivation check refuses a pair the server would refuse anyway,
// before anything reaches the socket: the first frame the server ever sees
// is the plain join sent afterwards as a marker.
func TestJoinRoomWithTokenRefusesMismatchedRoomIdLocally(t *testing.T) {
	frames := make(chan []byte, 8)
	srv := fakeServer(t, func(conn *websocket.Conn) {
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			frames <- raw
		}
	})
	c := dial(t, srv)

	tokA, roomA := tokenPair(t)
	_, roomB := tokenPair(t)
	cases := []struct {
		name, room, tok string
	}{
		{"another token's room", roomB, tokA},
		{"uppercase room id", strings.ToUpper(roomA), tokA},
		{"empty room id", "", tokA},
		{"not a UUID", "not-a-room", tokA},
		{"42-character token", roomA, tokA[:42]},
		{"44-character token", roomA, tokA + "A"},
		{"empty token and room", "", ""},
	}
	for _, tc := range cases {
		start := time.Now()
		got, err := c.JoinRoomWithToken(tc.room, tc.tok)
		if got != HostInvalidToken || err == nil {
			t.Errorf("%s: result = %v, err = %v; want %v and an error", tc.name, got, err, HostInvalidToken)
		}
		if err != nil && tc.tok != "" && strings.Contains(err.Error(), tc.tok) {
			t.Errorf("%s: the error text carries the host token", tc.name)
		}
		if d := time.Since(start); d > 100*time.Millisecond {
			t.Errorf("%s: took %v; a local refusal waits for nothing", tc.name, d)
		}
	}

	const marker = "00000000-0000-4000-8000-000000000000"
	if err := c.JoinRoom(marker); err != nil {
		t.Fatalf("JoinRoom: %v", err)
	}
	first := frameWithin(t, frames, 3*time.Second)
	if want := `{"roomId":"` + marker + `","type":"join-room"}` + wireEnd; string(first) != want {
		t.Fatalf("first frame on the wire = %s, want the marker %s: a refused pair was sent", redact(first, tokA), want)
	}
}

// Every answer a visitor can get to request-join (spec 04 5.5), and the
// request-join frame byte for byte.
func TestRequestJoinTypedResults(t *testing.T) {
	cases := []struct {
		name    string
		answer  string
		want    RequestJoinResult
		wantErr bool
	}{
		{"request-joined visitor", `{"type":"request-joined","role":"visitor"}`, VisitorJoined, false},
		{"host-absent", `{"type":"host-absent"}`, VisitorHostAbsent, false},
		{"room-full", `{"type":"room-full"}`, VisitorRoomFull, false},
		{"disabled", `{"type":"disabled"}`, VisitorDisabled, false},
		{"error Invalid room ID", `{"type":"error","message":"Invalid room ID"}`, VisitorInvalidRoom, false},
		{"a role that is not the visitor's", `{"type":"room-joined","role":"sender"}`, VisitorInvalidRoom, true},
		{"socket closes", "close", VisitorDown, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, room := tokenPair(t)
			srv, frames := answerServer(t, tc.answer)
			c := dial(t, srv)

			got, err := c.RequestJoin(room)
			if got != tc.want {
				t.Fatalf("result = %v, want %v (err %v)", got, tc.want, err)
			}
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, want an error: %v", err, tc.wantErr)
			}
			if frame, want := frameWithin(t, frames, 3*time.Second), `{"type":"request-join","roomId":"`+room+`"}`+wireEnd; string(frame) != want {
				t.Fatalf("request-join frame = %s, want %s", frame, want)
			}
		})
	}

	t.Run("no answer", func(t *testing.T) {
		shrinkReplyTimeout(t, 200*time.Millisecond)
		_, room := tokenPair(t)
		srv, _ := answerServer(t, "")
		c := dial(t, srv)
		if got, err := c.RequestJoin(room); got != VisitorTimeout || err == nil {
			t.Fatalf("result = %v, err = %v; want %v and an error", got, err, VisitorTimeout)
		}
	})
}

// request-seal, request-reopen and request-close carry the joined room id
// and nothing else, byte for byte.
func TestRequestControlMessagesWriteExactFrames(t *testing.T) {
	frames := make(chan []byte, 8)
	srv := fakeServer(t, func(conn *websocket.Conn) {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"room-joined","role":"host"}`))
		for i := 0; i < 3; i++ {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			frames <- raw
		}
	})
	c := dial(t, srv)
	tok, room := tokenPair(t)
	if got, err := c.JoinRoomWithToken(room, tok); got != HostJoined || err != nil {
		t.Fatalf("join: %v, %v", got, err)
	}
	for _, step := range []struct {
		send func() error
		kind string
	}{
		{c.RequestSeal, "request-seal"},
		{c.RequestReopen, "request-reopen"},
		{c.RequestClose, "request-close"},
	} {
		if err := step.send(); err != nil {
			t.Fatalf("%s: %v", step.kind, err)
		}
		want := `{"type":"` + step.kind + `","roomId":"` + room + `"}` + wireEnd
		if got := frameWithin(t, frames, 3*time.Second); string(got) != want {
			t.Fatalf("%s frame = %s, want %s", step.kind, redact(got, tok), want)
		}
	}
}

// pingLoopGoroutines counts goroutines running the liveness ping loop, from
// a full stack dump, so a test can see one start and stop.
func pingLoopGoroutines() int {
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if n < len(buf) {
			buf = buf[:n]
			break
		}
		buf = make([]byte, 2*len(buf))
	}
	count := 0
	for _, g := range strings.Split(string(buf), "\n\n") {
		if strings.Contains(g, "signaling.(*Client).pingLoop") {
			count++
		}
	}
	return count
}

// waitPingLoops polls until exactly want ping loops run, or fails.
func waitPingLoops(t *testing.T, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		got := pingLoopGoroutines()
		if got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d ping loops running, want %d", got, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// The app ping the desktop's waiting link sends every 25 s, at a shrunk
// interval: exactly {"type":"ping"} on the wire, repeatedly, and nothing
// once the client is closed.
func TestLivenessPingEvery25s(t *testing.T) {
	waitPingLoops(t, 0)
	pings := make(chan []byte, 64)
	srv := fakeServer(t, func(conn *websocket.Conn) {
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			pings <- raw
			_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"pong"}`))
		}
	})
	c, err := Connect(strings.Replace(srv.URL, "http://", "ws://", 1), WithLiveness(40*time.Millisecond, 5*time.Second))
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	t.Cleanup(c.Close)
	for i := 0; i < 3; i++ {
		if got := frameWithin(t, pings, 3*time.Second); string(got) != `{"type":"ping"}`+wireEnd {
			t.Fatalf("ping %d = %s, want {\"type\":\"ping\"}", i, got)
		}
	}
	waitPingLoops(t, 1)
	c.Close()
	waitPingLoops(t, 0)
}

// A server that stops sending, while the TCP connection stays up, is found
// by the read deadline: Down closes within the shrunk deadline and PeerLeft
// still gets its push. Protocol-level pings from the server do not count as
// life, because they carry nothing a waiting host could act on.
func TestLivenessReadDeadlineDetectsSilentServer(t *testing.T) {
	for _, tc := range []struct {
		name   string
		handle func(*websocket.Conn)
	}{
		{"silent", func(*websocket.Conn) {}},
		{"control pings only", func(conn *websocket.Conn) {
			for i := 0; i < 30; i++ {
				if conn.WriteControl(websocket.PingMessage, []byte("hb"), time.Now().Add(time.Second)) != nil {
					return
				}
				time.Sleep(50 * time.Millisecond)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := fakeServer(t, tc.handle)
			start := time.Now()
			c := dial(t, srv, WithLiveness(0, 300*time.Millisecond))
			select {
			case <-c.Down:
			case <-time.After(3 * time.Second):
				t.Fatal("Down did not close: a silent server was not detected")
			}
			if elapsed := time.Since(start); elapsed < 250*time.Millisecond {
				t.Fatalf("Down closed after %v, before the 300ms deadline could pass", elapsed)
			}
			select {
			case <-c.PeerLeft:
			default:
				t.Fatal("PeerLeft got no push when the socket was lost")
			}
		})
	}
}

// readLoopOrder finds, in client.go's readLoop, the position of the
// close(c.Down) call and of the first send on c.PeerLeft.
func readLoopOrder(t *testing.T) (closeDown, sendPeerLeft token.Pos) {
	t.Helper()
	f, err := parser.ParseFile(token.NewFileSet(), "client.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	isField := func(e ast.Expr, name string) bool {
		sel, ok := e.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != name {
			return false
		}
		id, ok := sel.X.(*ast.Ident)
		return ok && id.Name == "c"
	}
	for _, d := range f.Decls {
		fn, ok := d.(*ast.FuncDecl)
		if !ok || fn.Recv == nil || fn.Name.Name != "readLoop" {
			continue
		}
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.CallExpr:
				if id, ok := x.Fun.(*ast.Ident); ok && id.Name == "close" && len(x.Args) == 1 && isField(x.Args[0], "Down") && !closeDown.IsValid() {
					closeDown = x.Pos()
				}
			case *ast.SendStmt:
				if isField(x.Chan, "PeerLeft") && !sendPeerLeft.IsValid() {
					sendPeerLeft = x.Pos()
				}
			}
			return true
		})
	}
	return closeDown, sendPeerLeft
}

// Down is a close, not a value: every reader sees it, as often as it looks.
// PeerLeft still gets its one push for the callers that predate Down, and it
// comes after Down, so a reader woken by PeerLeft already sees Down closed.
//
// The order is checked in the source first: the window between the two
// statements is nanoseconds wide, so the behavioral half below catches a
// swapped order only now and then (1 to 3 runs in 50, review L1), while the
// source check fails every run.
func TestDownClosesOnceAndPeerLeftStillPushes(t *testing.T) {
	closeDown, sendPeerLeft := readLoopOrder(t)
	if !closeDown.IsValid() || !sendPeerLeft.IsValid() {
		t.Fatalf("readLoop: close(c.Down) found %v, c.PeerLeft send found %v; want both", closeDown.IsValid(), sendPeerLeft.IsValid())
	}
	if closeDown > sendPeerLeft {
		t.Fatal("readLoop pushes PeerLeft before it closes Down")
	}

	srv := fakeServer(t, func(conn *websocket.Conn) { _ = conn.Close() })
	c := dial(t, srv)

	select {
	case <-c.PeerLeft:
	case <-time.After(3 * time.Second):
		t.Fatal("PeerLeft got no push after the socket closed")
	}
	select {
	case <-c.Down:
	default:
		t.Fatal("PeerLeft arrived before Down closed")
	}
	for i := 0; i < 3; i++ {
		select {
		case <-c.Down:
		case <-time.After(time.Second):
			t.Fatalf("read %d of Down blocked: it must stay closed", i)
		}
	}
	// Close after the read loop ended, twice, and nothing panics.
	c.Close()
	c.Close()
}

// assertQuiet fails unless every channel of c is empty and Down is open.
func assertQuiet(t *testing.T, c *Client) {
	t.Helper()
	select {
	case v := <-c.Role:
		t.Fatalf("Role got %q", v)
	case v := <-c.PeerConnected:
		t.Fatalf("PeerConnected got %q", v)
	case v := <-c.Signal:
		t.Fatalf("Signal got %s", v)
	case <-c.PeerLeft:
		t.Fatal("PeerLeft got a push")
	case <-c.RoomFull:
		t.Fatal("RoomFull got a push")
	case v := <-c.Errors:
		t.Fatalf("Errors got %q", v)
	case v := <-c.Refused:
		t.Fatalf("Refused got %q", v)
	case <-c.HostAbsent:
		t.Fatal("HostAbsent got a push")
	case <-c.Disabled:
		t.Fatal("Disabled got a push")
	case <-c.Down:
		t.Fatal("Down closed")
	default:
	}
}

// Unknown types, including the pong the server answers a ping with and the
// optional request-state acknowledgment of gap G9, are skipped: no channel
// moves and the loop keeps going.
func TestUnknownMessageTypesIgnored(t *testing.T) {
	srv := testServer(t, func(conn *websocket.Conn) {
		for _, f := range []string{
			`{"type":"pong"}`,
			`{"type":"request-state","state":"open"}`,
			`{"type":"future-type","code":"disabled","role":"host"}`,
			`{"type":"Room-Full"}`,
			`{"type":""}`,
			`{}`,
		} {
			_ = conn.WriteMessage(websocket.TextMessage, []byte(f))
		}
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","message":"sentinel"}`))
	})
	c := dial(t, srv)
	select {
	case msg := <-c.Errors:
		if msg != "sentinel" {
			t.Fatalf("Errors got %q, want the sentinel", msg)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the sentinel never arrived: an unknown type stopped the loop")
	}
	assertQuiet(t, c)
}

// hostileFrames are the frames TestMalformedServerFramesDoNotPanic sends,
// and the fuzz target's seeds.
func hostileFrames() map[string][]byte {
	return map[string][]byte{
		"null":                 []byte(`null`),
		"empty array":          []byte(`[]`),
		"array":                []byte(`[{"type":"refused","code":"disabled"}]`),
		"string":               []byte(`"refused"`),
		"number":               []byte(`42`),
		"not JSON":             []byte(`{not json`),
		"empty":                {},
		"code a number":        []byte(`{"type":"refused","code":5}`),
		"code an object":       []byte(`{"type":"refused","code":{"x":"disabled"}}`),
		"code an array":        []byte(`{"type":"refused","code":["disabled"]}`),
		"code true":            []byte(`{"type":"refused","code":true}`),
		"role a number":        []byte(`{"type":"room-joined","role":7}`),
		"role an object":       []byte(`{"type":"request-joined","role":{"r":"visitor"}}`),
		"type a number":        []byte(`{"type":3}`),
		"type an array":        []byte(`{"type":["refused"],"code":"disabled"}`),
		"message a number":     []byte(`{"type":"error","message":1e999}`),
		"signal truncated":     []byte(`{"type":"signal","signal":{"type":"offer"`),
		"deep nesting":         []byte(strings.Repeat("[", 100000)),
		"deep code field":      []byte(`{"type":"refused","code":` + strings.Repeat("[", 1<<19) + `}`),
		"1 MB of text":         bytes.Repeat([]byte("x"), 1<<20),
		"1 MB unknown type":    []byte(`{"type":"x","pad":"` + strings.Repeat("p", 1<<20) + `"}`),
		"1 MB code wrong type": []byte(`{"type":"refused","code":[` + strings.Repeat(`"p",`, 1<<18) + `"p"]}`),
	}
}

// Nothing a server sends can panic the decoder or stop the read loop: not
// null, arrays, bare values, a 1 MB frame, deep nesting, or a field of the
// wrong type. A frame whose fields do not decode is skipped whole, as every
// frame always was, so a code of the wrong type never reaches Refused.
func TestMalformedServerFramesDoNotPanic(t *testing.T) {
	frames := hostileFrames()
	t.Run("dispatch", func(t *testing.T) {
		for name, raw := range frames {
			c := newClient(nil, config{})
			c.dispatch(raw)
			func() {
				defer func() {
					if r := recover(); r != nil {
						t.Fatalf("%s: %v", name, r)
					}
				}()
				assertQuiet(t, c)
			}()
		}
	})
	t.Run("read loop", func(t *testing.T) {
		srv := fakeServer(t, func(conn *websocket.Conn) {
			for _, raw := range frames {
				_ = conn.WriteMessage(websocket.TextMessage, raw)
			}
			_ = conn.WriteMessage(websocket.BinaryMessage, []byte(`{"type":"refused","code":"disabled"}`))
			_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","message":"sentinel"}`))
		})
		c := dial(t, srv)
		select {
		case msg := <-c.Errors:
			if msg != "sentinel" {
				t.Fatalf("Errors got a hostile frame's message first (%d bytes)", len(msg))
			}
		case <-time.After(10 * time.Second):
			t.Fatal("the sentinel never arrived: a hostile frame stopped the loop")
		}
		// The binary frame is the one well-formed refused frame in the
		// stream; gorilla hands binary and text frames to the decoder alike.
		select {
		case code := <-c.Refused:
			if code != "disabled" {
				t.Fatalf("Refused got %q from a malformed frame", code)
			}
		default:
			t.Fatal("the well-formed binary refused frame was not decoded")
		}
		assertQuiet(t, c)
	})
}

// A plain Connect keeps the CLI's send and receive exactly as they were: no
// options, no read deadline and no ping goroutine. The liveness client next
// to it shows the goroutine count can see a ping loop at all.
func TestPlainConnectHasNoLiveness(t *testing.T) {
	waitPingLoops(t, 0)
	srv := fakeServer(t, func(*websocket.Conn) {})
	c := dial(t, srv)
	if c.cfg != (config{}) {
		t.Fatalf("plain Connect set options: %+v", c.cfg)
	}
	waitPingLoops(t, 0)
	time.Sleep(600 * time.Millisecond)
	select {
	case <-c.Down:
		t.Fatal("a plain client dropped a silent connection: it has a read deadline")
	default:
	}
	if n := pingLoopGoroutines(); n != 0 {
		t.Fatalf("%d ping loops after a plain Connect, want 0", n)
	}

	live := dial(t, fakeServer(t, func(*websocket.Conn) {}), WithLiveness(time.Hour, 0))
	waitPingLoops(t, 1)
	live.Close()
	waitPingLoops(t, 0)
}

// The overflow rule of the existing channels (TestReadLoopSurvivesRepeated*,
// unchanged above) holds for the new ones: repeated refused, host-absent,
// disabled and request-joined frames with nobody reading never wedge the
// loop, and each buffer keeps exactly one value.
func TestChannelOverflowUnchanged(t *testing.T) {
	srv := testServer(t, func(conn *websocket.Conn) {
		for i := 0; i < 3; i++ {
			for _, f := range []string{
				`{"type":"refused","code":"limited"}`,
				`{"type":"host-absent"}`,
				`{"type":"disabled"}`,
				`{"type":"request-joined","role":"visitor"}`,
			} {
				_ = conn.WriteMessage(websocket.TextMessage, []byte(f))
			}
		}
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","message":"after"}`))
	})
	c := dial(t, srv)
	select {
	case <-c.Errors:
	case <-time.After(3 * time.Second):
		t.Fatal("the frame after the surplus never arrived: the loop wedged")
	}
	if got := <-c.Refused; got != "limited" {
		t.Fatalf("Refused = %q", got)
	}
	<-c.HostAbsent
	<-c.Disabled
	if got := <-c.Role; got != "visitor" {
		t.Fatalf("Role = %q", got)
	}
	assertQuiet(t, c)
}

// The result names are fixed words: nothing a caller passed or the server
// sent can appear in them.
func TestResultStringsAreFixed(t *testing.T) {
	host := map[HostJoinResult]string{
		0: "unknown", HostJoined: "joined", HostRefusedDisabled: "refused-disabled",
		HostRefusedLimited: "refused-limited", HostRefusedUnknown: "refused-unknown",
		HostRoomFull: "room-full", HostInvalidToken: "invalid-token", HostInvalidRoom: "invalid-room",
		HostOldServer: "old-server", HostTimeout: "timeout", HostDown: "down", HostDown + 1: "unknown",
	}
	for r, want := range host {
		if got := r.String(); got != want {
			t.Errorf("HostJoinResult(%d).String() = %q, want %q", int(r), got, want)
		}
	}
	visitor := map[RequestJoinResult]string{
		0: "unknown", VisitorJoined: "joined", VisitorHostAbsent: "host-absent",
		VisitorRoomFull: "room-full", VisitorDisabled: "disabled", VisitorInvalidRoom: "invalid-room",
		VisitorTimeout: "timeout", VisitorDown: "down", VisitorDown + 1: "unknown",
	}
	for r, want := range visitor {
		if got := r.String(); got != want {
			t.Errorf("RequestJoinResult(%d).String() = %q, want %q", int(r), got, want)
		}
	}
}

// The package never prints or logs anything, so the host token it carries
// into join-room has no way to a terminal or a log: no fmt.Print or Fprint,
// no package log, no os.Stdout or os.Stderr, no print builtins, in any
// non-test file.
func TestPackageNeverPrints(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		f, err := parser.ParseFile(token.NewFileSet(), name, src, 0)
		if err != nil {
			t.Fatal(err)
		}
		checked++
		ast.Inspect(f, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.SelectorExpr:
				if id, ok := x.X.(*ast.Ident); ok {
					switch {
					case id.Name == "fmt" && (strings.HasPrefix(x.Sel.Name, "Print") || strings.HasPrefix(x.Sel.Name, "Fprint")),
						id.Name == "log",
						id.Name == "os" && (x.Sel.Name == "Stdout" || x.Sel.Name == "Stderr"):
						t.Errorf("%s prints: %s.%s", name, id.Name, x.Sel.Name)
					}
				}
			case *ast.CallExpr:
				if id, ok := x.Fun.(*ast.Ident); ok && (id.Name == "print" || id.Name == "println") {
					t.Errorf("%s calls the %s builtin", name, id.Name)
				}
			}
			return true
		})
	}
	if checked < 2 {
		t.Fatalf("checked %d files, want client.go and hosttoken.go at least", checked)
	}
}
