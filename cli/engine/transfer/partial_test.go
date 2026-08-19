package transfer

// Staged-write behavior: bytes land in a ".part" staging file and take the
// final name only through the commit rename, so a process killed at any moment
// can leave nothing on disk that looks complete. These tests pin that
// invariant, the never-overwrite commit, and the Ctrl+C abandon path.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestReceiverMidTransferOnlyPartOnDisk is the kill-safety invariant. The
// OnProgress callback runs synchronously inside the receive loop, so what the
// directory holds during a callback is exactly what a kill at that instant
// would leave behind: one .part file, and nothing at the final name. A
// subprocess kill-simulation was considered and rejected; a kill exercises
// precisely "the deferred cleanup never ran", and this proves the on-disk
// state at every deferrable instant deterministically instead of flakily.
func TestReceiverMidTransferOnlyPartOnDisk(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	var mu sync.Mutex
	var midTransfer [][]string

	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFilesWithProgress(dc, outDir, true, "", "", func(p Progress) {
			if p.FileBytes < p.FileSize {
				mu.Lock()
				midTransfer = append(midTransfer, listDir(t, outDir))
				mu.Unlock()
			}
		})
	}()

	time.Sleep(300 * time.Millisecond)

	meta := `{"type":"metadata","id":"p-1","fileName":"inv.bin","fileSize":4096,"index":1,"total":1,"totalBytes":4096}`
	if err := sender.SendText(meta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}
	for i := 0; i < 4; i++ {
		if err := sender.Send(make([]byte, 1024)); err != nil {
			t.Fatalf("Send chunk: %v", err)
		}
	}
	if err := sender.SendText(`{"type":"end"}`); err != nil {
		t.Fatalf("SendText end: %v", err)
	}

	select {
	case err := <-recvErr:
		if err != nil {
			t.Fatalf("receive failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ReceiveFiles did not return")
	}

	mu.Lock()
	snapshots := midTransfer
	mu.Unlock()
	if len(snapshots) == 0 {
		t.Fatal("no mid-transfer progress snapshots captured")
	}
	for _, snap := range snapshots {
		if len(snap) != 1 || snap[0] != "inv.bin"+partSuffix {
			t.Fatalf("mid-transfer disk state = %v, want exactly [inv.bin%s]", snap, partSuffix)
		}
	}
	if left := listDir(t, outDir); len(left) != 1 || left[0] != "inv.bin" {
		t.Fatalf("after completion disk state = %v, want exactly [inv.bin]", left)
	}
}

// TestReceiverRenameCollisionAtEnd plants a file at the claimed final name
// while the transfer is in flight. The intruder must survive byte-identical
// (Go's os.Rename REPLACES existing destinations on every platform, so a
// "simplified" bare rename would clobber it), the payload must land at the
// next base candidate, and the last progress event must carry the corrected
// SavedName.
func TestReceiverRenameCollisionAtEnd(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	planted := false
	var mu sync.Mutex
	var lastSaved string

	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFilesWithProgress(dc, outDir, true, "", "", func(p Progress) {
			mu.Lock()
			lastSaved = p.SavedName
			if !planted {
				planted = true
				if err := os.WriteFile(filepath.Join(outDir, "clash.bin"), []byte("INTRUDER"), 0666); err != nil {
					t.Errorf("plant intruder: %v", err)
				}
			}
			mu.Unlock()
		})
	}()

	time.Sleep(300 * time.Millisecond)

	meta := `{"type":"metadata","id":"p-2","fileName":"clash.bin","fileSize":2048,"index":1,"total":1,"totalBytes":2048}`
	if err := sender.SendText(meta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}
	payload := make([]byte, 1024)
	for i := range payload {
		payload[i] = 0x7a
	}
	for i := 0; i < 2; i++ {
		if err := sender.Send(payload); err != nil {
			t.Fatalf("Send chunk: %v", err)
		}
	}
	if err := sender.SendText(`{"type":"end"}`); err != nil {
		t.Fatalf("SendText end: %v", err)
	}

	select {
	case err := <-recvErr:
		if err != nil {
			t.Fatalf("receive failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ReceiveFiles did not return")
	}

	if b, err := os.ReadFile(filepath.Join(outDir, "clash.bin")); err != nil || string(b) != "INTRUDER" {
		t.Fatalf("intruder at the final name was touched: %q, %v", b, err)
	}
	got, err := os.ReadFile(filepath.Join(outDir, "clash (1).bin"))
	if err != nil {
		t.Fatalf("payload missing at the numbered sibling: %v", err)
	}
	if len(got) != 2048 || got[0] != 0x7a {
		t.Fatalf("payload content wrong: %d bytes", len(got))
	}
	mu.Lock()
	defer mu.Unlock()
	if lastSaved != "clash (1).bin" {
		t.Fatalf("last SavedName = %q, want %q", lastSaved, "clash (1).bin")
	}
	if left := listDir(t, outDir); len(left) != 2 {
		t.Fatalf("expected exactly two files, found %v", left)
	}
}

// TestAbandonPartialsRemovesInflight pins the Close-before-Remove order: Go
// opens files on Windows without FILE_SHARE_DELETE, so a path-only removal of
// a still-open staging file fails with a sharing violation.
func TestAbandonPartialsRemovesInflight(t *testing.T) {
	dir := t.TempDir()
	f, _, err := claimPart(filepath.Join(dir, "doomed.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte("half")); err != nil {
		t.Fatal(err)
	}
	registerPartial(f) // handle deliberately left open, like a live receive

	AbandonPartials()

	if left := listDir(t, dir); len(left) != 0 {
		t.Fatalf("expected the staging file removed, found %v", left)
	}
}

// TestAbandonPartialsSparesCompletedFile reproduces the historical hazard: an
// abandon call landing in the window after a file completed. The commit rename
// vacated the registered .part path, so the abandon must find nothing to
// remove and the completed file must survive.
func TestAbandonPartialsSparesCompletedFile(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "keep.bin")
	f, dest, err := claimPart(base)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte("precious")); err != nil {
		t.Fatal(err)
	}
	f.Close()
	registerPartial(f)

	if _, err := commitPart(f.Name(), dest, base); err != nil {
		t.Fatal(err)
	}
	// The receiver unregisters after committing; the hazard is an abandon that
	// fires BEFORE that (e.g. Ctrl+C during the post-completion grace wait).
	AbandonPartials()

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("completed file was deleted by the abandon: %v", err)
	}
	if string(got) != "precious" {
		t.Fatalf("completed file content = %q", got)
	}
	if strings.Contains(strings.Join(listDir(t, dir), " "), partSuffix) {
		t.Fatalf("a staging file survived: %v", listDir(t, dir))
	}
}

// TestCommitAbandonTorture is the regression net for two empirically proven
// races in an earlier ordering, where AbandonPartials removed a registered
// path while commitPart's rename was moving it: the delete disposition
// followed the file to its final name (both syscalls reported success and the
// committed file vanished), and a freed path re-claimed by another receive
// could be published under a stale commit's name. With unregistration before
// the commit, under the abandon's own mutex, neither interleave exists: every
// commit that reports success must leave its exact payload on disk.
func TestCommitAbandonTorture(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "abandon.bin")

	stop := make(chan struct{})
	var spam sync.WaitGroup
	spam.Add(1)
	go func() {
		defer spam.Done()
		// Paced, not a hot loop: production calls AbandonPartials once, at
		// process exit. An unpaced loop hammering close/remove/re-create on
		// colliding paths thousands of times a second can park a Close on
		// the FD semaphore deep in the Windows poller, which is not an
		// interleave any real exit path can produce. The pacing still lands
		// hundreds of abandons across every phase of the claim/write/commit
		// cycle, which is what the regression net needs.
		for {
			select {
			case <-stop:
				return
			case <-time.After(200 * time.Microsecond):
				AbandonPartials()
			}
		}
	}()

	const workers, rounds = 8, 25
	type result struct {
		dest    string
		payload string
	}
	var mu sync.Mutex
	var committed []result

	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for r := 0; r < rounds; r++ {
				payload := fmt.Sprintf("w%d-r%d", w, r)
				f, dest, err := claimPart(base)
				if err != nil {
					continue // a concurrent abandon can beat a claim; that is its job
				}
				registerPartial(f)
				if _, err := f.Write([]byte(payload)); err != nil {
					// Production order: owners unregister BEFORE closing, so
					// abandon is the only goroutine that ever closes a
					// registered file (a cross-goroutine double Close can
					// deadlock on Windows).
					unregisterPartial(f)
					f.Close()
					continue
				}
				// The production order: unregister, close, verify, commit.
				unregisterPartial(f)
				f.Close()
				final, err := commitPart(f.Name(), dest, base)
				if err != nil {
					continue
				}
				mu.Lock()
				committed = append(committed, result{final, payload})
				mu.Unlock()
			}
		}(w)
	}
	wg.Wait()
	close(stop)
	spam.Wait()

	for _, c := range committed {
		got, err := os.ReadFile(c.dest)
		if err != nil {
			t.Errorf("commit reported success at %s but the file is gone: %v", c.dest, err)
			continue
		}
		if string(got) != c.payload {
			t.Errorf("commit at %s holds %q, want %q (stolen bytes)", c.dest, got, c.payload)
		}
	}
	if t.Failed() {
		t.Logf("%d successful commits audited", len(committed))
	}
}
