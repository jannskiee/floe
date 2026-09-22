package transfer

// Staged-write behavior: bytes land in a ".part" staging file and take the
// final name only through the commit rename, so a process killed at any moment
// can leave nothing on disk that looks complete. These tests pin that
// invariant, the never-overwrite commit, and the Ctrl+C abandon path.

import (
	"errors"
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

	// A raw sender has no SendFiles drain, so wait for the end frame to leave
	// the buffer before closing, or the close would suppress it. Then close as
	// the CLI's deferred conn.Close() does, instead of leaving the receiver to
	// wait out its 5 s post-completion grace.
	flushControl(sender)
	_ = sender.Close()

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

	// Flush the end frame out of the buffer before closing (see the note in
	// TestReceiverMidTransferOnlyPartOnDisk), then close so this does not wait
	// out the receiver's 5 s post-completion grace.
	flushControl(sender)
	_ = sender.Close()

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
	f, _, err := claimPart(filepath.Join(dir, "doomed.bin"), nil)
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
	f, dest, err := claimPart(base, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte("precious")); err != nil {
		t.Fatal(err)
	}
	f.Close()
	registerPartial(f)

	if _, err := commitPart(f.Name(), dest, base, 0); err != nil {
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
				f, dest, err := claimPart(base, nil)
				if err != nil {
					continue // a concurrent abandon can beat a claim; that is its job
				}
				registerPartial(f)
				if _, err := f.Write([]byte(payload)); err != nil {
					// Production order: unregister, then the owner's own Close
					// arbitrates ownership of the path (see the receiver).
					unregisterPartial(f)
					if f.Close() == nil {
						_ = os.Remove(f.Name())
					}
					continue
				}
				// Production order: unregister, then Sync and Close double as
				// the ownership proof. If either fails, an abandon closed the
				// handle first, the path may already belong to another
				// worker's fresh claim, and committing by path would steal it.
				unregisterPartial(f)
				if f.Sync() != nil {
					f.Close()
					continue
				}
				if f.Close() != nil {
					continue
				}
				final, err := commitPart(f.Name(), dest, base, 0)
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

// TestCommitPart pins the publish step: the verified bytes land at the claimed
// name with no .part left behind, and a name taken between claim and commit
// advances through the BASE candidate sequence (never "shot (1) (1).png"),
// without ever overwriting the intruder.
func TestCommitPart(t *testing.T) {
	dir := t.TempDir()

	// Plain path: claim, write, commit.
	base := filepath.Join(dir, "doc.pdf")
	f, dest, err := claimPart(base, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte("payload")); err != nil {
		t.Fatal(err)
	}
	f.Close()
	final, err := commitPart(f.Name(), dest, base, 0)
	if err != nil {
		t.Fatalf("commitPart: %v", err)
	}
	if final != dest {
		t.Errorf("commit landed at %q, want the claimed %q", final, dest)
	}
	if b, err := os.ReadFile(final); err != nil || string(b) != "payload" {
		t.Fatalf("final content = %q, %v", b, err)
	}
	if _, err := os.Lstat(f.Name()); !os.IsNotExist(err) {
		t.Errorf("staging file %q survived the commit", f.Name())
	}

	// Interference path: something claims the final name mid-transfer. The
	// intruder must survive byte-identical and the payload must land at the
	// next BASE candidate.
	base2 := filepath.Join(dir, "clash.bin")
	f2, dest2, err := claimPart(base2, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f2.Write([]byte("mine")); err != nil {
		t.Fatal(err)
	}
	f2.Close()
	if err := os.WriteFile(dest2, []byte("INTRUDER"), 0666); err != nil {
		t.Fatal(err)
	}
	final2, err := commitPart(f2.Name(), dest2, base2, 0)
	if err != nil {
		t.Fatalf("commitPart with occupied dest: %v", err)
	}
	if got := filepath.Base(final2); got != "clash (1).bin" {
		t.Errorf("re-collision landed at %q, want %q", got, "clash (1).bin")
	}
	if b, _ := os.ReadFile(dest2); string(b) != "INTRUDER" {
		t.Errorf("intruder was overwritten: %q", b)
	}
	if b, _ := os.ReadFile(final2); string(b) != "mine" {
		t.Errorf("payload content = %q, want %q", b, "mine")
	}
}

// renameStub replaces renamePart for one test: the first fails calls fail the
// way an antivirus or indexer lock does (every call when fails is negative),
// and the rest rename for real. It runs on the receive goroutine; the counts
// are read after the receive or commitPart has returned.
type renameStub struct {
	mu    sync.Mutex
	fails int
	calls []time.Time
}

var errSimulatedLock = errors.New("simulated sharing violation on the .part")

func stubRename(t *testing.T, fails int) *renameStub {
	t.Helper()
	orig := renamePart
	t.Cleanup(func() { renamePart = orig })
	s := &renameStub{fails: fails}
	renamePart = func(src, dst string) error {
		s.mu.Lock()
		s.calls = append(s.calls, time.Now())
		n := len(s.calls)
		s.mu.Unlock()
		if s.fails < 0 || n <= s.fails {
			return &os.LinkError{Op: "rename", Old: src, New: dst, Err: errSimulatedLock}
		}
		return orig(src, dst)
	}
	return s
}

func (s *renameStub) attempts() []time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]time.Time(nil), s.calls...)
}

// stagedPart claims base in a fresh folder and writes body to its .part, the
// state commitPart starts from.
func stagedPart(t *testing.T, body string) (part, dest, base string) {
	t.Helper()
	base = filepath.Join(t.TempDir(), "report.pdf")
	f, dest, err := claimPart(base, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(body); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return f.Name(), dest, base
}

// TestCommitRetrySucceedsOnThirdAttempt (VR2-12): a lock that clears on the
// third attempt commits the file, with a CommitRetry window and with the zero
// value's five attempts alike, and the .part is gone afterward.
func TestCommitRetrySucceedsOnThirdAttempt(t *testing.T) {
	for _, retry := range []time.Duration{5 * time.Second, 0} {
		t.Run(retry.String(), func(t *testing.T) {
			stub := stubRename(t, 2)
			part, dest, base := stagedPart(t, "verified")
			final, err := commitPart(part, dest, base, retry)
			if err != nil {
				t.Fatalf("commitPart: %v", err)
			}
			if final != dest {
				t.Fatalf("committed at %s, want %s", final, dest)
			}
			if n := len(stub.attempts()); n != 3 {
				t.Fatalf("%d rename attempts, want 3", n)
			}
			if got, err := os.ReadFile(dest); err != nil || string(got) != "verified" {
				t.Fatalf("final file %q, %v", got, err)
			}
			if _, err := os.Stat(part); !os.IsNotExist(err) {
				t.Fatalf("the .part is still there after the commit: %v", err)
			}
		})
	}
}

// TestCommitRetryZeroKeepsFiveAttempts: CommitRetry zero, the CLI and code
// receive, is today's bounded retry exactly: five attempts 200 ms apart, then
// the error, with the verified .part left where it is.
func TestCommitRetryZeroKeepsFiveAttempts(t *testing.T) {
	stub := stubRename(t, -1)
	part, dest, base := stagedPart(t, "verified")
	start := time.Now()
	_, err := commitPart(part, dest, base, 0)
	took := time.Since(start)
	if !errors.Is(err, errSimulatedLock) {
		t.Fatalf("commitPart error = %v, want the lock", err)
	}
	if n := len(stub.attempts()); n != 5 {
		t.Fatalf("%d rename attempts, want 5", n)
	}
	if took < 750*time.Millisecond || took > 3*time.Second {
		t.Fatalf("five attempts took %v, want about 800 ms (four 200 ms waits)", took)
	}
	if got, err := os.ReadFile(part); err != nil || string(got) != "verified" {
		t.Fatalf("the verified .part was not kept: %q, %v", got, err)
	}
}

// TestCommitRetryGivesUpAfterWindowAndSendsSaveBlocked (E-36): a lock that
// outlasts the CommitRetry window ends the receive with save-blocked on the
// wire within 2 s of the window running out, a *CommitError naming the .part,
// and the verified .part still on disk (the data-loss rule: complete bytes are
// never deleted over a lock).
func TestCommitRetryGivesUpAfterWindowAndSendsSaveBlocked(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	const window = 2 * time.Second
	stubDisk(t, 0, 1<<40)
	stub := stubRename(t, -1)
	run := runHostile(t, metaFor("a.txt", 4, 1, 1, 4), []byte("abcd"), ReceiveOptions{
		Limits: &ReceiveLimits{MaxFiles: 10000, CommitRetry: window},
	})
	if run.refusal == nil || run.refusal.Code != string(CodeSaveBlocked) || run.refusal.Reason != CodeSaveBlocked.WireReason() {
		t.Fatalf("frame = %+v, want save-blocked with its wire reason", run.refusal)
	}
	if run.refusal.Saved == nil || *run.refusal.Saved != 0 {
		t.Fatalf("frame saved = %v, want 0", run.refusal.Saved)
	}
	var commitErr *CommitError
	if !errors.As(run.err, &commitErr) {
		t.Fatalf("receive error = %v (%T), want *CommitError", run.err, run.err)
	}
	if got, err := os.ReadFile(commitErr.PartPath); err != nil || string(got) != "abcd" {
		t.Fatalf("the verified .part at %s was not kept: %q, %v", commitErr.PartPath, got, err)
	}
	if strings.Join(run.tree, "|") != "a.txt.part" {
		t.Fatalf("output tree %v, want only the kept a.txt.part", run.tree)
	}
	attempts := stub.attempts()
	if len(attempts) < 2 {
		t.Fatalf("%d rename attempts, want the window retried", len(attempts))
	}
	spent := run.refusalAt.Sub(attempts[0])
	if spent < window-100*time.Millisecond {
		t.Fatalf("gave up %v after the first attempt, before the %v window", spent, window)
	}
	if spent > window+2*time.Second {
		t.Fatalf("the sender heard save-blocked %v after the first attempt, want within 2 s of the %v window", spent, window)
	}
}

// TestCommitRetryLastFileStillEndsInReceived (E-36): a lock on the last file
// that clears inside the window commits it, and the receive still ends the
// way every good receive does, with the received frame and no error.
func TestCommitRetryLastFileStillEndsInReceived(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	stubDisk(t, 0, 1<<40)
	stub := stubRename(t, 2)
	run := runHostile(t, metaFor("a.txt", 4, 1, 1, 4), []byte("abcd"), ReceiveOptions{
		Limits: &ReceiveLimits{MaxFiles: 10000, CommitRetry: 5 * time.Second},
	})
	wantSaved(t, run, "a.txt")
	if !run.received {
		t.Fatal("no received frame reached the sender")
	}
	if n := len(stub.attempts()); n != 3 {
		t.Fatalf("%d rename attempts, want 3", n)
	}
}
