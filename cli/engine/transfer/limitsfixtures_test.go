package transfer

// The pairing spike's hostile metadata F1 to F6 (baseline 02-pairing-spike,
// zz_spike_hostoffer_test.go:963-969, results/F*.json), replayed against the
// real receive loop, and the layer 1 tests built on them. Layer 1 is the set
// of sanity limits every Go receiver applies with no option to turn them off
// (D-033), so every test here except the request-link rows of the fixture
// table runs with Limits == nil: that is the plain CLI and desktop receive.
//
// What the spike saw before the limits existed: F2 created 40 nested folders,
// F4b created Windows/System32/ under the save folder, F5 acked an 8 PiB file,
// and F6 reached OnIncoming and then failed at the claim with a raw OS error
// (S1-ENG-01's R17 backstop later turned that into a write-failed frame, still
// after OnIncoming). F1 was already refused and F3 and F4a were already safe;
// those three are re-pinned here unchanged.
//
// Driven over real in-process pion pairs (hash_test.go's handSender).

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// spikeFixture is one of the spike's metadata frames, byte for byte, and the
// file bytes its sender sends once acked.
type spikeFixture struct {
	name string
	meta string
	data []byte
}

// spikeFixtures is F1 to F6 as the spike sent them.
func spikeFixtures() []spikeFixture {
	deep := strings.Repeat("d/", 40) + "deep.txt"
	return []spikeFixture{
		{"F1_fileSize_2pow53", `{"type":"metadata","id":"f-1","fileName":"big.bin","fileSize":9007199254740992,"index":1,"total":1,"totalBytes":9007199254740992,"pv":1,"pvMin":1,"ver":"spike-raw"}`, nil},
		{"F2_path_40_levels", `{"type":"metadata","id":"f-2","fileName":"` + deep + `","fileSize":4,"index":1,"total":1,"totalBytes":4,"pv":1,"pvMin":1,"ver":"spike-raw"}`, []byte("deep")},
		{"F3_bidi_override_name", `{"type":"metadata","id":"f-3","fileName":"photo\u202egnp.exe","fileSize":4,"index":1,"total":1,"totalBytes":4,"pv":1,"pvMin":1,"ver":"spike-raw"}`, []byte("bidi")},
		{"F4a_traversal_dotdot", `{"type":"metadata","id":"f-4a","fileName":"../../escape.txt","fileSize":4,"index":1,"total":1,"totalBytes":4,"pv":1,"pvMin":1,"ver":"spike-raw"}`, []byte("trav")},
		{"F4b_absolute_windows_path", `{"type":"metadata","id":"f-4b","fileName":"C:\\Windows\\System32\\evil.dll","fileSize":4,"index":1,"total":1,"totalBytes":4,"pv":1,"pvMin":1,"ver":"spike-raw"}`, []byte("abso")},
		{"F5_fileSize_max_allowed_2pow53_minus_1", `{"type":"metadata","id":"f-5","fileName":"big.bin","fileSize":9007199254740991,"index":1,"total":1,"totalBytes":9007199254740991,"pv":1,"pvMin":1,"ver":"spike-raw"}`, nil},
		{"F6_name_700_bytes_under_control_cap", `{"type":"metadata","id":"f-6","fileName":"` + strings.Repeat("n", 700) + `.txt","fileSize":4,"index":1,"total":1,"totalBytes":4,"pv":1,"pvMin":1,"ver":"spike-raw"}`, []byte("long")},
	}
}

// spikeFixtureNamed looks one fixture up by its spike name.
func spikeFixtureNamed(t *testing.T, name string) spikeFixture {
	t.Helper()
	for _, f := range spikeFixtures() {
		if f.name == name {
			return f
		}
	}
	t.Fatalf("no spike fixture %q", name)
	return spikeFixture{}
}

// metaFor builds a metadata frame for one hand-written file.
func metaFor(name string, size, index, total, totalBytes int64) string {
	b, _ := json.Marshal(map[string]interface{}{
		"type": "metadata", "id": "lim", "fileName": name, "fileSize": size,
		"index": index, "total": total, "totalBytes": totalBytes, "pv": 1, "pvMin": 1,
	})
	return string(b)
}

// hostileRun is what one receive against a hand-written sender left behind.
type hostileRun struct {
	acked    bool
	refusal  *incompatibleMsg // the incompatible frame, when the receiver sent one
	firstIn  time.Duration    // from the metadata to the first frame back
	err      error
	incoming int
	tree     []string // every file and folder under the output folder, folders ending in "/"
}

// runHostile sends meta to a fresh receive into its own folder. When the
// receiver acks, it sends data and an end, or, for nil data, closes the way a
// sender that gives up does; a "received" frame closes too, as a Go sender
// does. It returns once the receive has returned.
func runHostile(t *testing.T, meta string, data []byte, opts ReceiveOptions) hostileRun {
	t.Helper()
	return runHostileIn(t, t.TempDir(), meta, data, opts)
}

func runHostileIn(t *testing.T, dir, meta string, data []byte, opts ReceiveOptions) hostileRun {
	t.Helper()
	return runScripted(t, dir, meta, opts, func(h *handSender, n int) {
		if data == nil {
			_ = h.sender.Close()
			return
		}
		h.bytes(data)
		h.text(`{"type":"end"}`)
	})
}

// runScripted is runHostileIn for a sender with more to say: it sends meta,
// then calls onAck with the running count each time an ack comes back.
func runScripted(t *testing.T, dir, meta string, opts ReceiveOptions, onAck func(h *handSender, n int)) hostileRun {
	t.Helper()
	// Written on the receive goroutine and read after the receive has
	// returned, which the recvErr channel orders.
	incoming := 0
	callerIncoming := opts.OnIncoming
	opts.OnIncoming = func(info IncomingInfo) {
		incoming++
		if callerIncoming != nil {
			callerIncoming(info)
		}
	}
	h := newHandSenderOpts(t, dir, opts)
	at := time.Now()
	h.text(meta)

	var run hostileRun
	var frames [][]byte
	acks := 0
	deadline := time.After(30 * time.Second)
	for returned := false; !returned; {
		select {
		case m := <-h.back:
			if len(frames) == 0 {
				run.firstIn = time.Since(at)
			}
			frames = append(frames, m.Data)
			switch kind, _ := classifyControl(m.Data); kind {
			case "ack":
				run.acked = true
				acks++
				onAck(h, acks)
			case "received":
				_ = h.sender.Close()
			}
		case run.err = <-h.recvErr:
			returned = true
		case <-deadline:
			t.Fatal("the receive did not return")
		}
	}
	// A refusal is flushed before the receive returns; collect a straggler.
	for collecting := true; collecting; {
		select {
		case m := <-h.back:
			if len(frames) == 0 {
				run.firstIn = time.Since(at)
			}
			frames = append(frames, m.Data)
		case <-time.After(300 * time.Millisecond):
			collecting = false
		}
	}
	h.restore()
	run.incoming = incoming
	for _, f := range frames {
		if kind, ok := classifyControl(f); ok && kind == "incompatible" {
			var incompat incompatibleMsg
			if err := json.Unmarshal(f, &incompat); err != nil {
				t.Fatalf("refusal frame is not JSON: %q", f)
			}
			if run.refusal != nil {
				t.Fatalf("two incompatible frames: %+v and %q", *run.refusal, f)
			}
			run.refusal = &incompat
		}
	}
	run.tree = treeOf(t, dir)
	return run
}

// summary is one line of what a run left behind, for the red and green
// evidence: whether the claim ran, what the sender was told, what the receive
// returned and how deep the output tree went.
func (r hostileRun) summary() string {
	frame := "none"
	if r.refusal != nil {
		frame = fmt.Sprintf("code=%q reason=%q", r.refusal.Code, r.refusal.Reason)
	}
	deepest := ""
	for _, p := range r.tree {
		if strings.Count(p, "/") > strings.Count(deepest, "/") || deepest == "" {
			deepest = p
		}
	}
	errText := "nil"
	if r.err != nil {
		errText = fmt.Sprintf("%T %q", r.err, displayText(r.err.Error(), 160))
	}
	return fmt.Sprintf("acked=%v incoming=%d frame{%s} err=%s tree=%d entries, deepest %q",
		r.acked, r.incoming, frame, errText, len(r.tree), displayText(deepest, 120))
}

// treeOf lists every file and folder under dir, slash-separated, folders with
// a trailing "/", sorted. A folder is the evidence that a claim ran: the
// deferred cleanup removes a staging file and never a directory.
func treeOf(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if path == dir {
			return nil
		}
		rel, _ := filepath.Rel(dir, path)
		rel = filepath.ToSlash(rel)
		if info.IsDir() {
			rel += "/"
		}
		out = append(out, rel)
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}
	sort.Strings(out)
	return out
}

// diskStub replaces the two volume seams for one test and records every
// free-space question the receive asks.
type diskStub struct {
	mu        sync.Mutex
	freeAsked []string
}

func (d *diskStub) asked() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.freeAsked...)
}

func stubDisk(t *testing.T, volumeMax, free int64) *diskStub {
	t.Helper()
	origMax, origFree := volumeMaxFn, diskFreeFn
	t.Cleanup(func() { volumeMaxFn, diskFreeFn = origMax, origFree })
	d := &diskStub{}
	volumeMaxFn = func(string) (int64, error) { return volumeMax, nil }
	diskFreeFn = func(dir string) (int64, error) {
		d.mu.Lock()
		d.freeAsked = append(d.freeAsked, dir)
		d.mu.Unlock()
		return free, nil
	}
	return d
}

// requestLimits is the request lane's Beta values (spec 05 8.3).
func requestLimits() *ReceiveLimits {
	return &ReceiveLimits{MaxFiles: 10000, FreeReserve: 2 << 30}
}

// fat32Max is the largest file a FAT32 volume holds, 4 GiB minus one byte,
// written out rather than taken from fat32MaxFileSize so the tables pin it.
const fat32Max = 4294967295

// wantRefused asserts a coded refusal that happened before anything was
// created: the frame with code and reason, saved 0, a *RefusedError whose text
// is fixed wording, and an output folder with nothing in it.
func wantRefused(t *testing.T, run hostileRun, code RefusalCode, reason string, leak ...string) {
	t.Helper()
	if run.acked {
		t.Fatal("the receiver acked, so the claim ran")
	}
	wantFrame(t, run, code, reason, 0, leak...)
	if len(run.tree) != 0 {
		t.Fatalf("the output folder holds %v; a refused path may create nothing", run.tree)
	}
}

// wantFrame asserts the refusal itself: the frame with code, reason and saved,
// and a *RefusedError carrying the same code and count whose fixed text names
// nothing from the file name. The caller asserts what is on disk.
func wantFrame(t *testing.T, run hostileRun, code RefusalCode, reason string, saved int, leak ...string) {
	t.Helper()
	if run.refusal == nil {
		t.Fatalf("no refusal frame reached the sender (receive error %v)", run.err)
	}
	if run.refusal.Code != string(code) {
		t.Fatalf("frame code = %q, want %q", run.refusal.Code, code)
	}
	if run.refusal.Reason != reason {
		t.Fatalf("frame reason = %q, want %q", run.refusal.Reason, reason)
	}
	if run.refusal.Saved == nil || *run.refusal.Saved != saved {
		t.Fatalf("frame saved = %v, want %d", run.refusal.Saved, saved)
	}
	var refused *RefusedError
	if !errors.As(run.err, &refused) || refused.Code != code || refused.Saved != saved {
		t.Fatalf("receive error = %v (%T), want *RefusedError{%q, %d}", run.err, run.err, code, saved)
	}
	for _, s := range append(leak, partSuffix) {
		if s != "" && (strings.Contains(run.err.Error(), s) || strings.Contains(run.refusal.Reason, s)) {
			t.Fatalf("%q from the file name reached the error %q or the reason %q", s, run.err, run.refusal.Reason)
		}
	}
}

// wantSaved asserts a receive that completed and left exactly tree behind.
func wantSaved(t *testing.T, run hostileRun, tree ...string) {
	t.Helper()
	if run.err != nil {
		t.Fatalf("receive error = %v, want success", run.err)
	}
	if run.refusal != nil {
		t.Fatalf("unexpected refusal frame %+v", *run.refusal)
	}
	sort.Strings(tree)
	if strings.Join(run.tree, "|") != strings.Join(tree, "|") {
		t.Fatalf("output tree %v, want %v", run.tree, tree)
	}
}

// TestHostileFixturesF1ToF6 replays the spike's six frames under three
// receivers: layer 1 on an NTFS-like volume (no maximum file size), layer 1 on
// a FAT32 volume, and a request-link receive with layer 2 on top. The volume
// questions are stubbed, so the table reads the same on every GOOS.
func TestHostileFixturesF1ToF6(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	type want struct {
		outcome  string // "refused", "rejected", "saved", "acked-then-closed"
		code     RefusalCode
		reason   string
		incoming int
		tree     []string
	}
	pathShape := want{outcome: "refused", code: CodePathTooLong, reason: reasonPathNotRelative}
	tooDeep := want{outcome: "refused", code: CodePathTooLong, reason: CodePathTooLong.WireReason()}
	f1 := want{outcome: "rejected", reason: "receiver rejected the file description: file size 9.007199254740992e+15 is not a byte count"}
	f3 := want{outcome: "saved", incoming: 1, tree: []string{"photo_gnp.exe"}}
	f4a := want{outcome: "saved", incoming: 1, tree: []string{"escape.txt"}}
	rows := map[string]map[string]want{
		"layer1-ntfs": {
			"F1_fileSize_2pow53":                     f1,
			"F2_path_40_levels":                      tooDeep,
			"F3_bidi_override_name":                  f3,
			"F4a_traversal_dotdot":                   f4a,
			"F4b_absolute_windows_path":              pathShape,
			"F5_fileSize_max_allowed_2pow53_minus_1": {outcome: "acked-then-closed", incoming: 1},
			"F6_name_700_bytes_under_control_cap":    tooDeep,
		},
		"layer1-fat32": {
			"F1_fileSize_2pow53":                     f1,
			"F2_path_40_levels":                      tooDeep,
			"F3_bidi_override_name":                  f3,
			"F4a_traversal_dotdot":                   f4a,
			"F4b_absolute_windows_path":              pathShape,
			"F5_fileSize_max_allowed_2pow53_minus_1": {outcome: "refused", code: CodeFileTooLargeForFolder, reason: CodeFileTooLargeForFolder.WireReason()},
			"F6_name_700_bytes_under_control_cap":    tooDeep,
		},
		"request-link": {
			"F1_fileSize_2pow53":                     f1,
			"F2_path_40_levels":                      tooDeep,
			"F3_bidi_override_name":                  f3,
			"F4a_traversal_dotdot":                   f4a,
			"F4b_absolute_windows_path":              pathShape,
			"F5_fileSize_max_allowed_2pow53_minus_1": {outcome: "refused", code: CodeDiskFull, reason: CodeDiskFull.WireReason(), incoming: 1},
			"F6_name_700_bytes_under_control_cap":    tooDeep,
		},
	}
	receivers := []struct {
		name      string
		volumeMax int64
		limits    func() *ReceiveLimits
	}{
		{"layer1-ntfs", 0, func() *ReceiveLimits { return nil }},
		{"layer1-fat32", fat32Max, func() *ReceiveLimits { return nil }},
		{"request-link", 0, requestLimits},
	}
	for _, rc := range receivers {
		for _, fx := range spikeFixtures() {
			w := rows[rc.name][fx.name]
			t.Run(rc.name+"/"+fx.name, func(t *testing.T) {
				// 1 TiB free: plenty for four bytes, far short of F5.
				stubDisk(t, rc.volumeMax, 1<<40)
				run := runHostile(t, fx.meta, fx.data, ReceiveOptions{Limits: rc.limits()})
				t.Logf("observed: %s", run.summary())
				if run.incoming != w.incoming {
					t.Fatalf("OnIncoming fired %d times, want %d", run.incoming, w.incoming)
				}
				switch w.outcome {
				case "refused":
					wantRefused(t, run, w.code, w.reason, "nnnn", "deep.txt", "d/d/", "evil", "Windows")
				case "rejected":
					// F1 keeps today's uncoded frame and plain error.
					if run.acked || run.refusal == nil || run.refusal.Code != "" || run.refusal.Reason != w.reason {
						t.Fatalf("acked=%v frame=%+v, want only the uncoded rejection %q", run.acked, run.refusal, w.reason)
					}
					if run.err == nil || !strings.Contains(run.err.Error(), "rejected the sender's file description") {
						t.Fatalf("receive error = %v, want the rejected file description", run.err)
					}
					if len(run.tree) != 0 {
						t.Fatalf("the output folder holds %v", run.tree)
					}
				case "saved":
					if !run.acked {
						t.Fatal("the receiver never acked")
					}
					wantSaved(t, run, w.tree...)
				case "acked-then-closed":
					// Today's F5: an ack for 8 PiB on a volume with no size
					// limit, and nothing left once the sender closes.
					if !run.acked || run.refusal != nil {
						t.Fatalf("acked=%v frame=%+v, want an ack and no refusal", run.acked, run.refusal)
					}
					if run.err == nil || !strings.Contains(run.err.Error(), "connection closed mid-transfer") {
						t.Fatalf("receive error = %v, want the mid-transfer close", run.err)
					}
					if len(run.tree) != 0 {
						t.Fatalf("the output folder holds %v after the sender closed", run.tree)
					}
				default:
					t.Fatalf("no outcome for %s/%s", rc.name, fx.name)
				}
			})
		}
	}
}

// TestUniversalDepth33RefusesPathTooLongBeforeMkdir: a path more than 32
// components deep is refused with path-too-long before the Incoming box, the
// prompt and OnIncoming, and before any folder exists. F2, 40 folders deep, is
// what the spike created on disk; depth 33 is the first one over.
func TestUniversalDepth33RefusesPathTooLongBeforeMkdir(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	rows := []struct{ name, meta string }{
		{"F2 at depth 41", spikeFixtureNamed(t, "F2_path_40_levels").meta},
		{"depth 33", metaFor(strings.Repeat("d/", 32)+"f.txt", 4, 1, 1, 4)},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			run := runHostile(t, row.meta, []byte("deep"), ReceiveOptions{})
			if run.incoming != 0 {
				t.Fatalf("OnIncoming fired %d times for a refused path", run.incoming)
			}
			wantRefused(t, run, CodePathTooLong, CodePathTooLong.WireReason(), "deep.txt", "f.txt", "d/d/")
		})
	}
}

// TestUniversalDepth32Accepted: 32 components, 31 folders and the file, is
// the deepest path that still arrives, rebuilt as sent.
func TestUniversalDepth32Accepted(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	name := strings.Repeat("d/", 31) + "f.txt"
	run := runHostile(t, metaFor(name, 4, 1, 1, 4), []byte("ok32"), ReceiveOptions{})
	var tree []string
	for i := 1; i <= 31; i++ {
		tree = append(tree, strings.Repeat("d/", i))
	}
	tree = append(tree, name)
	wantSaved(t, run, tree...)
}

// TestUniversalAbsoluteAndDriveLetterPathsRefused: a name that starts at a
// drive or a root is refused outright on every receiver, instead of being
// stripped to a relative path and saved (the spike's F4b created
// Windows/System32/evil.dll under the save folder). The GOOS does not matter:
// a Linux receiver refuses a Windows drive path too.
func TestUniversalAbsoluteAndDriveLetterPathsRefused(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	names := []string{
		`C:\Windows\System32\evil.dll`,
		`\\server\share\x`,
		`/etc/x`,
		`c:evil`,
		`C:/Windows/evil.dll`,
		`//server/share/x`,
		`\\?\C:\x`,
		`\Windows\evil.dll`,
	}
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			run := runHostile(t, metaFor(name, 4, 1, 1, 4), []byte("abso"), ReceiveOptions{})
			if run.incoming != 0 {
				t.Fatalf("OnIncoming fired %d times for a refused path", run.incoming)
			}
			wantRefused(t, run, CodePathTooLong, reasonPathNotRelative, "evil", "server", "etc")
		})
	}
	t.Run("F4b byte for byte", func(t *testing.T) {
		fx := spikeFixtureNamed(t, "F4b_absolute_windows_path")
		run := runHostile(t, fx.meta, fx.data, ReceiveOptions{})
		wantRefused(t, run, CodePathTooLong, reasonPathNotRelative, "evil", "Windows")
	})
}

// TestUniversalPath241UnitsRefusedBeforeThePrompt: a relative path whose
// staging name would pass 240 UTF-16 units is refused before OnIncoming, the
// sender hears it within 2 s, and the receive returns a typed refusal rather
// than the raw create error the spike's F6 produced. Nothing is on disk.
func TestUniversalPath241UnitsRefusedBeforeThePrompt(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	rows := []struct{ name, meta string }{
		{"flat 241 units", metaFor(strings.Repeat("u", 241-len(partSuffix)), 4, 1, 1, 4)},
		// The separator counts: 4 + 232 + 5 = 241.
		{"nested 241 units", metaFor("dir/"+strings.Repeat("u", 232), 4, 1, 1, 4)},
		// Two-unit characters count twice: 118 of them plus ".part" is 241.
		{"astral 241 units", metaFor(strings.Repeat("\U0001F600", 118), 4, 1, 1, 4)},
		{"F6 704-byte name", spikeFixtureNamed(t, "F6_name_700_bytes_under_control_cap").meta},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			run := runHostile(t, row.meta, []byte("long"), ReceiveOptions{})
			if run.incoming != 0 {
				t.Fatalf("OnIncoming fired %d times; the owner may never be asked about a path the receiver refuses", run.incoming)
			}
			if run.firstIn > 2*time.Second {
				t.Fatalf("the sender was told %v after the metadata, want within 2 s", run.firstIn)
			}
			wantRefused(t, run, CodePathTooLong, CodePathTooLong.WireReason(), "uuuu", "nnnn")
		})
	}
}

// TestUniversalPath240UnitsAccepted: exactly 240 units with ".part" still
// arrives, flat and nested.
func TestUniversalPath240UnitsAccepted(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	flat := strings.Repeat("u", 240-len(partSuffix))
	nested := "dir/" + strings.Repeat("v", 231)
	t.Run("flat", func(t *testing.T) {
		wantSaved(t, runHostile(t, metaFor(flat, 4, 1, 1, 4), []byte("ok40"), ReceiveOptions{}), flat)
	})
	t.Run("nested", func(t *testing.T) {
		wantSaved(t, runHostile(t, metaFor(nested, 4, 1, 1, 4), []byte("ok40"), ReceiveOptions{}), "dir/", nested)
	})
}

// TestUniversalVolumeMaxRefusesFileTooLargeForFolder: on a FAT32 volume a
// 5 GiB file is refused before OnIncoming with file-too-large-for-folder,
// instead of failing after 4 GiB crossed the link. 4 GiB minus one byte, the
// largest file FAT32 holds, is still acked.
func TestUniversalVolumeMaxRefusesFileTooLargeForFolder(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	t.Run("5 GiB", func(t *testing.T) {
		stubDisk(t, fat32Max, -1)
		const size = 5 << 30
		run := runHostile(t, metaFor("clip.mp4", size, 1, 1, size), nil, ReceiveOptions{})
		if run.incoming != 0 {
			t.Fatalf("OnIncoming fired %d times for a file the drive cannot hold", run.incoming)
		}
		wantRefused(t, run, CodeFileTooLargeForFolder, CodeFileTooLargeForFolder.WireReason(), "clip")
	})
	t.Run("4 GiB minus one byte", func(t *testing.T) {
		stubDisk(t, fat32Max, -1)
		run := runHostile(t, metaFor("clip.mp4", fat32Max, 1, 1, fat32Max), nil, ReceiveOptions{})
		if !run.acked || run.refusal != nil {
			t.Fatalf("acked=%v frame=%+v, want the largest FAT32 file acked", run.acked, run.refusal)
		}
	})
}

// TestUniversalTraversalStillContained: F4a is unchanged by layer 1: the
// dot-dot segments are dropped and the file lands inside the output folder.
func TestUniversalTraversalStillContained(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	fx := spikeFixtureNamed(t, "F4a_traversal_dotdot")
	wantSaved(t, runHostile(t, fx.meta, fx.data, ReceiveOptions{}), "escape.txt")
}

// TestUniversalBidiNameStillSanitized: F3 is unchanged by layer 1: the
// right-to-left override becomes "_" on disk and in OnIncoming.
func TestUniversalBidiNameStillSanitized(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	fx := spikeFixtureNamed(t, "F3_bidi_override_name")
	var first string
	run := runHostile(t, fx.meta, fx.data, ReceiveOptions{OnIncoming: func(info IncomingInfo) { first = info.FirstName }})
	wantSaved(t, run, "photo_gnp.exe")
	if first != "photo_gnp.exe" {
		t.Fatalf("OnIncoming FirstName = %q, want photo_gnp.exe", first)
	}
}

// TestUniversalAnnouncedSizeAbove2Pow53StillRejected: F1 is unchanged by
// layer 1: byteCount rejects the size before anything else runs, with the
// uncoded frame and plain error it has always had.
func TestUniversalAnnouncedSizeAbove2Pow53StillRejected(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	fx := spikeFixtureNamed(t, "F1_fileSize_2pow53")
	run := runHostile(t, fx.meta, fx.data, ReceiveOptions{})
	if run.incoming != 0 || run.acked {
		t.Fatalf("incoming=%d acked=%v for an impossible size", run.incoming, run.acked)
	}
	if run.refusal == nil || run.refusal.Code != "" || !strings.Contains(run.refusal.Reason, "is not a byte count") {
		t.Fatalf("frame = %+v, want the uncoded byte-count rejection", run.refusal)
	}
	if run.err == nil || !strings.Contains(run.err.Error(), "rejected the sender's file description") {
		t.Fatalf("receive error = %v", run.err)
	}
	if len(run.tree) != 0 {
		t.Fatalf("the output folder holds %v", run.tree)
	}
	if code, _ := checkAnnouncedSize(maxAnnouncedSize+1, 0); code != CodeFileTooLargeForFolder {
		t.Fatalf("checkAnnouncedSize(2^53, 0) = %q; the re-pin must refuse it too", code)
	}
}

// TestUniversalOverCapMetadataFrameCarriesPathTooLong: a metadata string past
// the 1000-byte control cap, which is what a deep folder path produces, now
// carries path-too-long on every receiver, so a current sender prints the
// fixed sentence. The reason is today's text, for peers that print it.
func TestUniversalOverCapMetadataFrameCarriesPathTooLong(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	meta := metaFor(strings.Repeat("folder/", 150)+"leaf.txt", 4, 1, 1, 4)
	if len(meta) <= controlMsgMax {
		t.Fatalf("fixture is %d bytes, must exceed the control cap", len(meta))
	}
	run := runHostile(t, meta, []byte("deep"), ReceiveOptions{})
	if run.incoming != 0 || run.acked {
		t.Fatalf("incoming=%d acked=%v for an over-cap frame", run.incoming, run.acked)
	}
	if run.refusal == nil {
		t.Fatal("no frame reached the sender")
	}
	if run.refusal.Code != string(CodePathTooLong) {
		t.Fatalf("frame code = %q, want %q", run.refusal.Code, CodePathTooLong)
	}
	wantReason := "receiver rejected the file description: control message is " + itoa(int64(len(meta))) + " bytes, limit 1000"
	if run.refusal.Reason != wantReason {
		t.Fatalf("frame reason = %q, want today's %q", run.refusal.Reason, wantReason)
	}
	if run.refusal.Saved == nil || *run.refusal.Saved != 0 {
		t.Fatalf("frame saved = %v, want 0", run.refusal.Saved)
	}
	if run.err == nil || !strings.Contains(run.err.Error(), "control message") {
		t.Fatalf("receive error = %v, want the control cap named", run.err)
	}
	if len(run.tree) != 0 {
		t.Fatalf("the output folder holds %v", run.tree)
	}
	// What a current Go sender makes of that frame: the fixed sentence.
	frame, _ := json.Marshal(run.refusal)
	var stopped *PeerStoppedError
	if err := abortFromPeer(frame, "", "", 1); !errors.As(err, &stopped) || stopped.Code != CodePathTooLong {
		t.Fatalf("abortFromPeer = %v, want a *PeerStoppedError for path-too-long", err)
	}
}

// TestExistingSuiteUnchangedUnderUniversalLimits: layer 1 is on for every
// receiver, so a legitimate transfer at its edges must still arrive whole: a
// real Go sender sends a folder with a file 32 components deep, a name at 240
// units with ".part", and names in scripts whose characters cost one, two and
// three bytes. Together with the whole package passing with layer 1 on, this
// is the evidence that only hostile shapes changed. The fixtures that did
// cross a layer 1 limit are named in the card's evidence.
func TestExistingSuiteUnchangedUnderUniversalLimits(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	src := t.TempDir()
	// "top/" plus 31 folders plus the leaf is 32 components below the output.
	deep := "top/" + strings.Repeat("d/", 30) + "leaf.txt"
	// 4 + 231 + 5 = 240 units.
	long := "top/" + strings.Repeat("l", 231)
	files := map[string][32]byte{
		deep:                         writeRandom(t, src, deep, 1024),
		long:                         writeRandom(t, src, long, 2048),
		"top/fotos/Überraschung.jpg": writeRandom(t, src, "top/fotos/Überraschung.jpg", 3000),
		"top/文档/报告.pdf":              writeRandom(t, src, "top/文档/报告.pdf", 4096),
		"top/emoji/\U0001F600.txt":   writeRandom(t, src, "top/emoji/\U0001F600.txt", 10),
	}
	out := runTransfer(t, []string{filepath.Join(src, "top")})
	for rel, sum := range files {
		got, err := os.ReadFile(filepath.Join(out, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatalf("%s did not arrive: %v", rel, err)
		}
		if sha256.Sum256(got) != sum {
			t.Fatalf("%s arrived with different bytes", rel)
		}
	}
	if got := listDir(t, out); len(got) != len(files) {
		t.Fatalf("output files %v, want exactly %d", got, len(files))
	}
}
