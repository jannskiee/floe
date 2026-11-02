package main

// The harness with a link key: -key prints a keyed link and uses the key, and -kc
// makes it a peer that fails the check, honestly: a proof under another key, or none.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/jannskiee/floe/cli/engine/code"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
)

// startSend is startRequest for send mode.
func startSend(t *testing.T, args ...string) *harnessRun {
	t.Helper()
	h := &harnessRun{
		sink: &lineSink{raw: make(chan string, 256), lines: make(chan map[string]interface{}, 256)},
		code: make(chan int, 1),
	}
	ev := &events{enc: json.NewEncoder(h.sink), exit: func(code int) { panic(exitPanic(code)) }}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				if code, ok := r.(exitPanic); ok {
					h.code <- int(code)
					return
				}
				panic(r)
			}
		}()
		runSend(ev, args)
	}()
	return h
}

// keyedReceive takes the second seat on the fake server and runs a real engine
// receive with kc, the far end of send mode.
func keyedReceive(url, room, out string, kc *transfer.KeyCheck) error {
	sc, err := signaling.Connect(url)
	if err != nil {
		return err
	}
	defer sc.Close()
	res, err := sc.RequestJoin(room)
	if err != nil || res != signaling.VisitorJoined {
		return errors.New("receiver not seated: " + res.String())
	}
	conn, err := peer.New(nil, sc)
	if err != nil {
		return err
	}
	defer conn.Close()
	dc, err := conn.SetupAsReceiver()
	if err != nil {
		return err
	}
	early := conn.Early()
	return transfer.ReceiveFilesWithOptions(dc, out, true, "test", "", transfer.ReceiveOptions{
		OnProgress: func(transfer.Progress) {},
		Messages:   early.Msgs,
		Closed:     early.Closed,
		KeyCheck:   kc,
	})
}

func keyedLinkShape(t *testing.T, link string) code.ResolvedLink {
	t.Helper()
	if !regexp.MustCompile(`^http://localhost:3000/#k=[A-Za-z0-9_-]{21}[AQgw]&room=[0-9a-f-]{36}$`).MatchString(link) {
		t.Fatalf("the link is %q", link)
	}
	parsed, err := code.ResolveLink("", link)
	if err != nil || !parsed.HasKey {
		t.Fatalf("the printed link does not parse: %v", err)
	}
	return parsed
}

func wantEmptyFolder(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("the folder holds %d entries", len(entries))
	}
}

// The default is today's keyless link, so each PR's CI stays as it was (DV3).
func TestSendModeIsKeylessUnlessAsked(t *testing.T) {
	srv := newFakeRequestServer(t)
	src, _ := namedPayload(t, "a.bin", 2048)
	h := startSend(t, "-server", srv.url, "-refusal-wait", "1s", src)
	link, _ := h.until(t, "link")["link"].(string)
	if !regexp.MustCompile(`^http://localhost:3000/#room=[0-9a-f-]{36}$`).MatchString(link) {
		t.Fatalf("the default link is %q", link)
	}
	parsed, err := code.ResolveLink("", link)
	if err != nil || parsed.HasKey {
		t.Fatalf("the default link: %v, has key %v", err, parsed.HasKey)
	}
	out := t.TempDir()
	if err := keyedReceive(srv.url, parsed.RoomID, out, nil); err != nil {
		t.Fatalf("receive: %v", err)
	}
	h.until(t, "peer-refused")
	if _, err := os.Stat(filepath.Join(out, "a.bin")); err != nil {
		t.Fatal(err)
	}
}

// send -key: a keyed link and an honest proof, so a real receiver holding that link
// saves the file. The key is in the link event and in no other event.
func TestSendModeKeyDelivers(t *testing.T) {
	srv := newFakeRequestServer(t)
	src, _ := namedPayload(t, "a.bin", 2048)
	h := startSend(t, "-server", srv.url, "-key", "-refusal-wait", "1s", src)
	link, _ := h.until(t, "link")["link"].(string)
	parsed := keyedLinkShape(t, link)
	out := t.TempDir()
	kc := &transfer.KeyCheck{Key: parsed.Key, RoomID: parsed.RoomID}
	if err := keyedReceive(srv.url, parsed.RoomID, out, kc); err != nil {
		t.Fatalf("receive: %v", err)
	}
	h.until(t, "peer-refused")
	if _, err := os.Stat(filepath.Join(out, "a.bin")); err != nil {
		t.Fatal(err)
	}
	if strings.Count(strings.Join(h.raws, "\n"), parsed.Key.Encode()) != 1 {
		t.Fatalf("the key is not in the link event alone: %v", h.names())
	}
}

// send -kc=bad and -kc=none: the link is whole and the proof is not, and a real
// receiver refuses before a byte is saved. The harness reports the code it read.
func TestSendModeFailingProofIsRefused(t *testing.T) {
	for _, mode := range []string{"bad", "none"} {
		t.Run(mode, func(t *testing.T) {
			srv := newFakeRequestServer(t)
			src, _ := namedPayload(t, "a.bin", 2048)
			h := startSend(t, "-server", srv.url, "-key", "-kc="+mode, src)
			link, _ := h.until(t, "link")["link"].(string)
			parsed := keyedLinkShape(t, link)
			out := t.TempDir()
			err := keyedReceive(srv.url, parsed.RoomID, out, &transfer.KeyCheck{Key: parsed.Key, RoomID: parsed.RoomID})
			if !errors.Is(err, transfer.ErrSenderNotConfirmed) {
				t.Fatalf("receive: %v", err)
			}
			wantEmptyFolder(t, out)
			if got := h.until(t, "peer-refused")["code"]; got != "unverified" {
				t.Fatalf("the harness read code %v", got)
			}
			if code := h.exitCode(t); code != 0 {
				t.Fatalf("exit %d", code)
			}
		})
	}
}

// A -kc with no -key, or a word that is not one, is a usage error, so a spec typo
// never reads as a failed check.
func TestSendModeKCFlagsAreChecked(t *testing.T) {
	src, _ := namedPayload(t, "a.bin", 16)
	for name, args := range map[string][]string{
		"-kc with no -key": {"-kc=bad", src},
		"a bad word":       {"-key", "-kc=lie", src},
	} {
		t.Run(name, func(t *testing.T) {
			h := startSend(t, args...)
			if code := h.exitCode(t); code != 2 {
				t.Fatalf("exit %d, want the usage code", code)
			}
		})
	}
}

// keyedVisit is visit holding the link's key: a real enforcing send, the /r page's
// rule, whose result the tests compare.
func keyedVisit(url string, kc *transfer.KeyCheck, room string, paths ...string) error {
	sc, err := signaling.Connect(url)
	if err != nil {
		return err
	}
	defer sc.Close()
	res, err := sc.RequestJoin(room)
	if err != nil || res != signaling.VisitorJoined {
		return errors.New("visitor not seated: " + res.String())
	}
	conn, err := peer.New(nil, sc)
	if err != nil {
		return err
	}
	defer conn.Close()
	dc, err := conn.SetupAsReceiver()
	if err != nil {
		return err
	}
	early := conn.Early()
	return transfer.SendFilesWithOptions(dc, paths, "visitor", transfer.SendOptions{
		OnProgress:      func(transfer.Progress) {},
		Messages:        early.Msgs,
		Closed:          early.Closed,
		RequireReceived: true,
		KeyCheck:        kc,
	})
}

func requestLinkKey(t *testing.T, link string) code.RequestLink {
	t.Helper()
	parsed, err := code.ParseRequestLink(link)
	if err != nil {
		t.Fatalf("the printed link does not parse: %v", err)
	}
	return parsed
}

func TestRequestModeIsKeylessUnlessAsked(t *testing.T) {
	srv := newFakeRequestServer(t)
	out := t.TempDir()
	h := startRequest(t, "-server", srv.url, "-out", out, "-timeout", "60s")
	link, _ := h.until(t, "link")["link"].(string)
	parsed := requestLinkKey(t, link)
	if parsed.HasKey || strings.Contains(strings.TrimPrefix(link, "http://localhost:3000/r/"), ".") {
		t.Fatalf("the default link is keyed: %q", link)
	}
	src, _ := namedPayload(t, "a.bin", 2048)
	if err := visit(srv.url, parsed.RoomID, src); err != nil {
		t.Fatalf("visitor: %v", err)
	}
	h.until(t, "done")
}

// request -key: the link is #<room>.<k>, the engine checks with it, and an honest
// visitor delivers. The key is in the link event and in no other event.
func TestRequestModeKeyDelivers(t *testing.T) {
	srv := newFakeRequestServer(t)
	out := t.TempDir()
	h := startRequest(t, "-server", srv.url, "-out", out, "-key", "-timeout", "60s")
	link, _ := h.until(t, "link")["link"].(string)
	if !regexp.MustCompile(`^http://localhost:3000/r/[A-Za-z0-9_-]{11}#[0-9a-f-]{36}\.[A-Za-z0-9_-]{21}[AQgw]$`).MatchString(link) {
		t.Fatalf("the link is %q", link)
	}
	if got, want := roomFromLink(t, link), requestLinkKey(t, link).RoomID; got != want {
		t.Fatalf("roomFromLink read %q, the parser %q", got, want)
	}
	parsed := requestLinkKey(t, link)
	src, _ := namedPayload(t, "a.bin", 2048)
	kc := &transfer.KeyCheck{Key: parsed.Key, RoomID: parsed.RoomID, Enforce: true}
	if err := keyedVisit(srv.url, kc, parsed.RoomID, src); err != nil {
		t.Fatalf("visitor: %v", err)
	}
	done := h.until(t, "done")
	if done["files"] != float64(1) {
		t.Fatalf("done = %v", done)
	}
	if strings.Count(strings.Join(h.raws, "\n"), parsed.Key.Encode()) != 1 {
		t.Fatalf("the key is not in the link event alone: %v", h.names())
	}
	if _, err := os.Stat(filepath.Join(out, "a.bin")); err != nil {
		t.Fatal(err)
	}
}

// request -kc=bad: the engine runs under a different key, so an honest visitor stops
// on the host's proof and the host refuses the visitor's, with no Decide.
func TestRequestModeBadKeyIsRefusedBothWays(t *testing.T) {
	srv := newFakeRequestServer(t)
	out := t.TempDir()
	h := startRequest(t, "-server", srv.url, "-out", out, "-key", "-kc=bad", "-timeout", "60s")
	link, _ := h.until(t, "link")["link"].(string)
	parsed := requestLinkKey(t, link)
	src, _ := namedPayload(t, "a.bin", 2048)
	kc := &transfer.KeyCheck{Key: parsed.Key, RoomID: parsed.RoomID, Enforce: true}
	if err := keyedVisit(srv.url, kc, parsed.RoomID, src); err != transfer.ErrReceiverNotConfirmed {
		t.Fatalf("visitor: %v", err)
	}
	if got := h.until(t, "refused")["code"]; got != "unverified" {
		t.Fatalf("the host refused with %v", got)
	}
	for _, name := range h.names() {
		if name == "deciding" || name == "accepted" {
			t.Fatalf("the host decided: %v", h.names())
		}
	}
	h.until(t, "done")
	wantEmptyFolder(t, out)
}

// request -kc=none: the engine runs with no key, so the link's key goes unused: a
// keyless visitor delivers, which only a host with no check allows.
func TestRequestModeNoProofRunsTheEngineWithoutAKey(t *testing.T) {
	srv := newFakeRequestServer(t)
	out := t.TempDir()
	h := startRequest(t, "-server", srv.url, "-out", out, "-key", "-kc=none", "-timeout", "60s")
	link, _ := h.until(t, "link")["link"].(string)
	parsed := requestLinkKey(t, link)
	if !parsed.HasKey {
		t.Fatalf("the link holds no key: %q", link)
	}
	src, _ := namedPayload(t, "a.bin", 2048)
	if err := visit(srv.url, parsed.RoomID, src); err != nil {
		t.Fatalf("a keyless visitor at a keyless engine: %v", err)
	}
	h.until(t, "done")
}

// An enforcing visitor at a host that shows no proof ends on silence, and the host
// reads the visitor's stop as unverified. Holds a real 15 s timer.
func TestRequestModeNoProofSilencesAnEnforcingVisitor(t *testing.T) {
	if os.Getenv("FLOE_LONG_TESTS") == "" {
		t.Skip("holds a real 15 s timer; set FLOE_LONG_TESTS to run it")
	}
	srv := newFakeRequestServer(t)
	out := t.TempDir()
	h := startRequest(t, "-server", srv.url, "-out", out, "-key", "-kc=none", "-timeout", "60s")
	link, _ := h.until(t, "link")["link"].(string)
	parsed := requestLinkKey(t, link)
	src, _ := namedPayload(t, "a.bin", 2048)
	kc := &transfer.KeyCheck{Key: parsed.Key, RoomID: parsed.RoomID, Enforce: true}
	if err := keyedVisit(srv.url, kc, parsed.RoomID, src); err != transfer.ErrReceiverSilent {
		t.Fatalf("visitor: %v", err)
	}
	if got := h.until(t, "refused")["code"]; got != "unverified" {
		t.Fatalf("the host refused with %v", got)
	}
	wantEmptyFolder(t, out)
}

func TestRequestFlagsForTheKey(t *testing.T) {
	cfg, err := parseRequestFlags([]string{"-out", "x"})
	if err != nil || cfg.keyed || cfg.kcMode != "" {
		t.Fatalf("the default: %+v, %v", cfg, err)
	}
	cfg, err = parseRequestFlags([]string{"-out", "x", "-key", "-kc=bad"})
	if err != nil || !cfg.keyed || cfg.kcMode != "bad" {
		t.Fatalf("-key -kc=bad: %+v, %v", cfg, err)
	}
	for name, args := range map[string][]string{
		"-kc with no -key": {"-out", "x", "-kc=none"},
		"a bad word":       {"-out", "x", "-key", "-kc=lie"},
	} {
		if _, err := parseRequestFlags(args); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// refusalWord reads the two shapes the check can end a visit in: this side's refusal,
// and the visitor's own stop for the code, which is the bare sentinel.
func TestRefusalWordKnowsTheKeyCheck(t *testing.T) {
	for _, err := range []error{transfer.ErrSenderNotConfirmed, &transfer.RefusedError{Code: transfer.CodeUnverified, Err: transfer.ErrSenderNotConfirmed}} {
		if word, ok := refusalWord(err); !ok || word != "unverified" {
			t.Errorf("%v: word %q, %v", err, word, ok)
		}
	}
}

func TestRefusalCodeKnowsTheKeyCheck(t *testing.T) {
	frame := fmt.Sprintf(`{"type":"incompatible","code":%q}`, "unverified")
	if got := refusalCode([]byte(frame)); got != "unverified" {
		t.Fatalf("refusalCode = %q", got)
	}
}
