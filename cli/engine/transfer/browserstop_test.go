package transfer

// The frames a browser sender sends when it stops on its own (an unreadable
// file, the 2 minute ack wait, an internal error, a relayed path refused with
// relay fallback off), and what a Go receiver makes of each. The browser half
// of the table is client/lib/senderSelfStop.test.ts, and both read
// testdata/browser-sender-stops.json, so neither side can change a frame or
// its reading alone.
//
// The receiver's incompatible branch is unchanged since v1.11.0 and
// desktop-v0.3.0, so this is also what the released floe and Floe Desktop
// show: the browser change ships to floe.one at merge, ahead of both.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

type browserStopRow struct {
	Name    string `json:"name"`
	Frame   string `json:"frame"`
	Browser string `json:"browser"`
	Go      string `json:"go"`
}

func TestReceiverReadsTheBrowserSendersOwnStops(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "browser-sender-stops.json"))
	if err != nil {
		t.Fatal(err)
	}
	var rows []browserStopRow
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) == 0 {
		t.Fatal("no rows in testdata/browser-sender-stops.json")
	}
	const metadata = `{"type":"metadata","id":"a","fileName":"a.bin","fileSize":4,"index":1,"total":1,"totalBytes":4,"pv":1,"pvMin":1}`

	for _, row := range rows {
		for _, midFile := range []bool{false, true} {
			name := row.Name + "/before-any-file"
			if midFile {
				name = row.Name + "/mid-file"
			}
			t.Run(name, func(t *testing.T) {
				sender, recvCh, msgs, closed, closeFn := newPumpedPair(t)
				defer closeFn()

				var rdc *webrtc.DataChannel
				select {
				case rdc = <-recvCh:
				case <-time.After(20 * time.Second):
					t.Fatal("receiver data channel never opened")
				}

				outDir := t.TempDir()
				recvErr := make(chan error, 1)
				go func() {
					recvErr <- ReceiveFilesWithOptions(rdc, outDir, true, "", "", ReceiveOptions{
						Messages: msgs,
						Closed:   closed,
					})
				}()

				// Text, as the browser sends every control frame; chunks binary.
				if midFile {
					if err := sender.SendText(metadata); err != nil {
						t.Fatal(err)
					}
					if err := sender.Send([]byte("ab")); err != nil {
						t.Fatal(err)
					}
				}
				if err := sender.SendText(row.Frame); err != nil {
					t.Fatal(err)
				}

				select {
				case err := <-recvErr:
					if err == nil {
						t.Fatal("the receiver reported success for a stopped transfer")
					}
					var compat *CompatError
					if !errors.As(err, &compat) || compat.LocalTooOld {
						t.Fatalf("error %T %v, want the sender's reason as a *CompatError", err, err)
					}
					if err.Error() != row.Go {
						t.Fatalf("receiver shows\n  %q\nwant\n  %q", err.Error(), row.Go)
					}
				case <-time.After(20 * time.Second):
					t.Fatal("ReceiveFilesWithOptions did not return")
				}

				entries, err := os.ReadDir(outDir)
				if err != nil {
					t.Fatal(err)
				}
				if len(entries) != 0 {
					t.Fatalf("the stopped file was kept: %v", entries)
				}
			})
		}
	}
}
