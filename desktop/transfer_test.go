package main

// The pieces of a send or a receive that need no peer (transfer.go): the
// text-send staging file and the relay gate behind Hide my IP.

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestWriteTextTemp verifies the text-send staging: exact content round-trip,
// the fixed message.txt name the receiver will see, and cleanup removing the
// temp directory.
func TestWriteTextTemp(t *testing.T) {
	const text = "hello floe\nline two · unicode ✓"

	path, cleanup, err := writeTextTemp(text)
	if err != nil {
		t.Fatalf("writeTextTemp: %v", err)
	}

	if got := filepath.Base(path); got != "message.txt" {
		t.Errorf("file name = %q, want message.txt", got)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != text {
		t.Errorf("content = %q, want %q", got, text)
	}

	cleanup()
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Errorf("cleanup did not remove the temp dir")
	}
}

// TestRequireRelay pins the transfer-time half of issue #281. Hide my IP forces
// the relay path, so without a TURN URL in the list the attempt gathers no
// usable candidate and dies about thirty seconds later as a generic timeout,
// which errors.ts turns into advice about both devices being online.
//
// The first case is the one a careless implementation breaks: a STUN-only
// server is a perfectly good server when the switch is off, and must not be
// refused.
func TestRequireRelay(t *testing.T) {
	cases := []struct {
		name      string
		hideIP    bool
		hasRelay  bool
		degraded  bool
		wantError error
	}{
		{"a relay-less server is fine with the switch off", false, false, false, nil},
		{"a relay-less server is refused with the switch on", true, false, false, errNoRelay},
		{"a relay-capable server is fine with the switch on", true, true, false, nil},
		{"a relay-capable server is fine with the switch off", false, true, false, nil},
		// The list this side is holding is the STUN-only fallback, so "no relay"
		// is this side's guess rather than the server's answer. Blaming the
		// server's configuration would be a confident guess at a wrong cause,
		// and the usual causes (a wrong address, an un-proxied /api/, the TURN
		// endpoint's rate limiter) are all things the reader can act on.
		{"a list that could not be read does not blame the server", true, false, true, errRelayUnknown},
		// Degraded but a relay somehow present cannot happen through
		// ice.FetchDetail today, since the fallback is STUN only. Pinned so a
		// future fallback with a relay in it does not silently start refusing.
		{"degraded is irrelevant once a relay is in the list", true, true, true, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := requireRelay(tc.hideIP, tc.hasRelay, tc.degraded)
			if !errors.Is(err, tc.wantError) {
				t.Fatalf("requireRelay(%v, %v, %v) = %v, want %v",
					tc.hideIP, tc.hasRelay, tc.degraded, err, tc.wantError)
			}
			if err == nil {
				return
			}
			// The message has to name the switch, or it is the same
			// unactionable failure in different words.
			if !strings.Contains(err.Error(), "Hide my IP") {
				t.Errorf("error %q does not name the setting to turn off", err)
			}
			// errors.ts matches on this clause to pass the sentence through
			// verbatim; see its PASSTHROUGH list.
			if !strings.Contains(err.Error(), "needs a TURN relay") {
				t.Errorf("error %q lost the clause errors.ts anchors on", err)
			}
		})
	}
}

// requestLinkPasteLinks are the browser-only link shapes a person may paste
// into Receive > CODE by mistake: request links on floe.one, on the local dev
// pair and on a self-hosted base path, and the Stage 2 drop shapes. Resolving
// them is local (a URL path match), so these tests make no network call.
var requestLinkPasteLinks = []string{
	"https://floe.one/r/Xk3p9Q0aB1c#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f",
	"http://localhost:3000/r/Xk3p9Q0aB1c#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f",
	"https://files.example.com/floe/r/Xk3p9Q0aB1c/#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f",
	"https://floe.one/d/aBcD1234#k=s3cr3t",
	"https://floe.one/drop/aBcD1234",
}

// TestReceiveByCodeMapsRequestLink: a pasted request or drop link comes back as
// the one approved sentence (CP2), not as "could not resolve" wrapped around
// the pasted text, which quoted the link, room id included, into the status
// line.
func TestReceiveByCodeMapsRequestLink(t *testing.T) {
	const cp2 = "That is a request link for sending files to someone. Open it in a web browser."
	for _, link := range requestLinkPasteLinks {
		a := &App{wake: &wakeGuard{}, notifyFn: func(string, string) {}}
		_, err := a.ReceiveByCode(link, t.TempDir(), false, false)
		if err == nil {
			t.Fatalf("%s: ReceiveByCode succeeded", link)
		}
		if err.Error() != cp2 {
			t.Errorf("%s: error = %q, want the CP2 sentence", link, err.Error())
		}
		if strings.Contains(err.Error(), "aBcD1234") || strings.Contains(err.Error(), "Xk3p9Q0aB1c") || strings.Contains(err.Error(), "6f1c2b9e") {
			t.Errorf("%s: the error quotes the pasted link: %q", link, err.Error())
		}
	}
}

// TestReceiveByCodeRequestLinkSendsNoToast: a pasted request link is a mix-up
// the status line explains, not a failed transfer, so the "receive failed"
// toast must not fire for it.
func TestReceiveByCodeRequestLinkSendsNoToast(t *testing.T) {
	var got []string
	a := &App{wake: &wakeGuard{}, notifyFn: func(title, body string) { got = append(got, title+"|"+body) }}
	for _, link := range requestLinkPasteLinks {
		if _, err := a.ReceiveByCode(link, t.TempDir(), false, false); err == nil {
			t.Fatalf("%s: ReceiveByCode succeeded", link)
		}
	}
	if len(got) != 0 {
		t.Errorf("pasted request links toasted %d times: %v", len(got), got)
	}
}
