package transfer

// The OnIncoming contract (ReceiveOptions.OnIncoming): it fires exactly once,
// with the batch summary, before the first OnProgress call. Driven with raw
// senders over real in-process pion pairs (see loopback_test.go for the
// harness).

import (
	"testing"
	"time"
)

// TestReceiverIncomingHookFiresBeforeFirstByte: OnIncoming must fire exactly
// once, with the batch summary, strictly before any OnProgress call.
func TestReceiverIncomingHookFiresBeforeFirstByte(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	// Both callbacks run on the receive loop goroutine, so an unlocked slice
	// is safe; the test reads it only after the receive returns.
	var events []string
	var got IncomingInfo
	opts := ReceiveOptions{
		OnIncoming: func(inc IncomingInfo) {
			events = append(events, "incoming")
			got = inc
		},
		OnProgress: func(Progress) {
			events = append(events, "progress")
		},
	}
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFilesWithOptions(dc, outDir, true, "", "", opts)
	}()

	time.Sleep(300 * time.Millisecond)

	meta := `{"type":"metadata","id":"c-7","fileName":"a.txt","fileSize":4,"index":1,"total":1,"totalBytes":4}`
	if err := sender.SendText(meta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}
	if err := sender.Send(make([]byte, 4)); err != nil {
		t.Fatalf("Send chunk: %v", err)
	}
	if err := sender.SendText(`{"type":"end"}`); err != nil {
		t.Fatalf("SendText end: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	_ = sender.Close()

	select {
	case err := <-recvErr:
		if err != nil {
			t.Fatalf("expected success, got: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("ReceiveFilesWithOptions did not return")
	}

	if len(events) == 0 || events[0] != "incoming" {
		t.Fatalf("expected the incoming hook to fire before any progress, got sequence %v", events)
	}
	if n := countOf(events, "incoming"); n != 1 {
		t.Fatalf("incoming hook fired %d times, want exactly 1", n)
	}
	if n := countOf(events, "progress"); n < 1 {
		t.Fatalf("no progress events fired, so the before-progress ordering claim is vacuous: %v", events)
	}
	if got.Files != 1 || got.TotalBytes != 4 || got.FirstName != "a.txt" {
		t.Fatalf("incoming payload = %+v, want Files=1 TotalBytes=4 FirstName=a.txt", got)
	}
}

// TestReceiverIncomingHookLegacyFallback: a sender that predates totalBytes
// still yields the single file's size in the incoming summary.
func TestReceiverIncomingHookLegacyFallback(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	var got IncomingInfo
	fired := 0
	opts := ReceiveOptions{
		OnIncoming: func(inc IncomingInfo) { fired++; got = inc },
	}
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFilesWithOptions(dc, outDir, true, "", "", opts)
	}()

	time.Sleep(300 * time.Millisecond)

	// No totalBytes field, like a pre-1.6.0 sender.
	meta := `{"type":"metadata","id":"c-8","fileName":"old.bin","fileSize":4,"index":1,"total":1}`
	if err := sender.SendText(meta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}
	if err := sender.Send(make([]byte, 4)); err != nil {
		t.Fatalf("Send chunk: %v", err)
	}
	if err := sender.SendText(`{"type":"end"}`); err != nil {
		t.Fatalf("SendText end: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	_ = sender.Close()

	select {
	case err := <-recvErr:
		if err != nil {
			t.Fatalf("expected success, got: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("ReceiveFilesWithOptions did not return")
	}
	if fired != 1 {
		t.Fatalf("incoming hook fired %d times, want 1", fired)
	}
	if got.TotalBytes != 4 {
		t.Fatalf("legacy fallback TotalBytes = %d, want the file size 4", got.TotalBytes)
	}
}

// TestIncomingInfoFirstSizeIsValidated: FirstSize is the first file's own
// announced size and not the batch total, and a number the sender could not
// have meant never reaches it, because the metadata carrying it is rejected
// before any IncomingInfo is built.
func TestIncomingInfoFirstSizeIsValidated(t *testing.T) {
	t.Run("carries the first file's own size", func(t *testing.T) {
		sender, recvCh, closeFn := newConnectedPair(t)
		defer closeFn()

		outDir := t.TempDir()
		var got IncomingInfo
		fired := 0
		recvErr := make(chan error, 1)
		go func() {
			dc := <-recvCh
			recvErr <- ReceiveFilesWithOptions(dc, outDir, true, "", "", ReceiveOptions{
				OnIncoming: func(inc IncomingInfo) { fired++; got = inc },
			})
		}()

		time.Sleep(300 * time.Millisecond)

		// Two files, 5 bytes then 7: the first file's size and the batch
		// total can only be told apart when they differ.
		for _, f := range []struct {
			meta string
			size int
		}{
			{`{"type":"metadata","id":"c-9a","fileName":"first.bin","fileSize":5,"index":1,"total":2,"totalBytes":12}`, 5},
			{`{"type":"metadata","id":"c-9b","fileName":"second.bin","fileSize":7,"index":2,"total":2,"totalBytes":12}`, 7},
		} {
			if err := sender.SendText(f.meta); err != nil {
				t.Fatalf("SendText metadata: %v", err)
			}
			if err := sender.Send(make([]byte, f.size)); err != nil {
				t.Fatalf("Send chunk: %v", err)
			}
			if err := sender.SendText(`{"type":"end"}`); err != nil {
				t.Fatalf("SendText end: %v", err)
			}
		}
		time.Sleep(300 * time.Millisecond)
		_ = sender.Close()

		select {
		case err := <-recvErr:
			if err != nil {
				t.Fatalf("expected success, got: %v", err)
			}
		case <-time.After(20 * time.Second):
			t.Fatal("ReceiveFilesWithOptions did not return")
		}
		if fired != 1 {
			t.Fatalf("incoming hook fired %d times, want 1", fired)
		}
		if got.Files != 2 || got.TotalBytes != 12 || got.FirstSize != 5 {
			t.Fatalf("incoming payload = %+v, want Files=2 TotalBytes=12 FirstSize=5", got)
		}
	})

	// parseMetadata is where every number enters, so a fileSize that fails
	// byteCount ends the receive before IncomingInfo exists.
	// hostile_test.go's TestReceiverRejectsImpossibleSizes drives the same
	// shapes over a real pair and proves OnIncoming never fires for them; this
	// pins the validator FirstSize now depends on.
	t.Run("a size the sender could not have meant is rejected", func(t *testing.T) {
		for _, tc := range []struct{ name, meta string }{
			{"negative", `{"type":"metadata","id":"c-10","fileName":"a.bin","fileSize":-1,"index":1,"total":1,"totalBytes":-1}`},
			{"fractional", `{"type":"metadata","id":"c-11","fileName":"a.bin","fileSize":1.5,"index":1,"total":1,"totalBytes":1.5}`},
			{"past the safe integer range", `{"type":"metadata","id":"c-12","fileName":"a.bin","fileSize":9007199254740992,"index":1,"total":1,"totalBytes":9007199254740992}`},
			{"past int64", `{"type":"metadata","id":"c-13","fileName":"a.bin","fileSize":1e300,"index":1,"total":1,"totalBytes":1e300}`},
		} {
			t.Run(tc.name, func(t *testing.T) {
				if info, err := parseMetadata(tc.meta); err == nil {
					t.Fatalf("parseMetadata accepted a %s file size and produced %+v; FirstSize would carry a number nobody validated", tc.name, info)
				}
			})
		}
		info, err := parseMetadata(`{"type":"metadata","id":"c-14","fileName":"a.bin","fileSize":5,"index":1,"total":2,"totalBytes":12}`)
		if err != nil || info.FileSize != 5 {
			t.Fatalf("parseMetadata of a plain 5-byte first file = %+v, %v", info, err)
		}
	})
}

func countOf(list []string, want string) int {
	n := 0
	for _, s := range list {
		if s == want {
			n++
		}
	}
	return n
}
