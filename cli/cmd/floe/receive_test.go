package main

import (
	"errors"
	"strings"
	"testing"

	"github.com/jannskiee/floe/cli/engine/code"
)

// A request or drop link pasted into `floe receive` is refused before any
// network call, with the approved sentence (TL-33) and nothing else: the
// generic "could not resolve %q" wrapper would print the whole link back, and
// for a request link that includes the room id in its fragment. The desktop
// returns the same sentinel bare for the same reason (desktop/transfer.go).
func TestReceiveRefusesALinkWithoutEchoingIt(t *testing.T) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	cases := []struct {
		name  string
		input string
		want  error
	}{
		{"request link", "https://floe.one/r/Xk3p9Q0aB1c#" + room, code.ErrRequestLink},
		{"drop link", "https://floe.one/d/Xk3p9Q0aB1c", code.ErrDropLink},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := runReceive(receiveCmd, []string{c.input})
			if err == nil {
				t.Fatalf("runReceive(%s) returned nil", c.name)
			}
			if !errors.Is(err, c.want) {
				t.Fatalf("error %q does not wrap the link sentinel", err)
			}
			if err.Error() != c.want.Error() {
				t.Fatalf("error text is %q, want the approved sentence alone: %q", err.Error(), c.want.Error())
			}
			for _, part := range []string{room, "Xk3p9Q0aB1c", "floe.one"} {
				if strings.Contains(err.Error(), part) {
					t.Fatalf("error text echoes %q from the pasted link: %q", part, err.Error())
				}
			}
		})
	}
}
