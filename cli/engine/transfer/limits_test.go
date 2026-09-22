package transfer

// The receive limits: the pure checks in limits.go against tables, then layer
// 2, the request-link limits, wired into a real receive loop. Layer 1 and the
// spike's hostile fixtures are in limitsfixtures_test.go, whose runner and
// disk stub these tests share.

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestCheckPathShape: the raw name decides "absolute", and the relative path
// safeJoin builds from it decides depth and length, so a traversal segment
// that safeJoin drops never counts toward either.
func TestCheckPathShape(t *testing.T) {
	notRelative := struct {
		code   RefusalCode
		reason string
	}{CodePathTooLong, reasonPathNotRelative}
	tooDeep := struct {
		code   RefusalCode
		reason string
	}{CodePathTooLong, CodePathTooLong.WireReason()}
	rows := []struct {
		name   string
		code   RefusalCode
		reason string
	}{
		{"a.txt", "", ""},
		{strings.Repeat("d/", 31) + "f.txt", "", ""},
		{strings.Repeat("d/", 32) + "f.txt", tooDeep.code, tooDeep.reason},
		{strings.Repeat("u", 235), "", ""},
		{strings.Repeat("u", 236), tooDeep.code, tooDeep.reason},
		{"dir/" + strings.Repeat("u", 231), "", ""},
		{"dir/" + strings.Repeat("u", 232), tooDeep.code, tooDeep.reason},
		{strings.Repeat("\U0001F600", 117), "", ""},
		{strings.Repeat("\U0001F600", 118), tooDeep.code, tooDeep.reason},
		// Dropped segments cost nothing: this is "a/b/c.txt" on disk.
		{"a/../b/./c.txt", "", ""},
		{"../../escape.txt", "", ""},
		{strings.Repeat("../", 40) + "x.txt", "", ""},
		{`C:\Windows\System32\evil.dll`, notRelative.code, notRelative.reason},
		{`C:/Windows/evil.dll`, notRelative.code, notRelative.reason},
		{"c:/evil", notRelative.code, notRelative.reason},
		{"C:", notRelative.code, notRelative.reason},
		{"z:", notRelative.code, notRelative.reason},
		// A letter and a colon with no separator after them is how macOS
		// stores a Finder name "P/L 2025.xlsx", and Linux allows it too: a
		// name, not a drive. safeJoin contains it (D-117).
		{"P:L 2025.xlsx", "", ""},
		{"c:evil", "", ""},
		{`\\server\share\x`, notRelative.code, notRelative.reason},
		{"//server/share/x", notRelative.code, notRelative.reason},
		{`\\?\C:\x`, notRelative.code, notRelative.reason},
		{`\\.\PhysicalDrive0`, notRelative.code, notRelative.reason},
		{"/etc/x", notRelative.code, notRelative.reason},
		{`\Windows\evil.dll`, notRelative.code, notRelative.reason},
		{"/", notRelative.code, notRelative.reason},
		// Only a drive or a root at the very start: these are relative.
		{`a/C:/b.txt`, "", ""},
		{`1:x.txt`, "", ""},
		{` C:\x.txt`, "", ""},
		{"", "", ""},
	}
	for _, row := range rows {
		rel := safeJoin("", row.name)
		code, reason := checkPathShape(row.name, rel)
		if code != row.code || reason != row.reason {
			t.Errorf("checkPathShape(%q, %q) = %q, %q; want %q, %q", row.name, rel, code, reason, row.code, row.reason)
		}
	}
}

// TestPathUnitsAndDepth pins the two measures: UTF-16 units with ".part"
// added, and components of the relative path.
func TestPathUnitsAndDepth(t *testing.T) {
	sep := string(filepath.Separator)
	units := []struct {
		rel  string
		want int
	}{
		{"a", 1 + len(partSuffix)},
		{"a" + sep + "b.txt", 7 + len(partSuffix)},
		{"\U0001F600", 2 + len(partSuffix)},
		{"é", 1 + len(partSuffix)},
		{"文档", 2 + len(partSuffix)},
	}
	for _, u := range units {
		if got := pathUnits(u.rel); got != u.want {
			t.Errorf("pathUnits(%q) = %d, want %d", u.rel, got, u.want)
		}
	}
	depths := []struct {
		rel  string
		want int
	}{
		{"a", 1},
		{"a" + sep + "b", 2},
		{strings.Repeat("d"+sep, 31) + "f", 32},
	}
	for _, d := range depths {
		if got := depthBelow(d.rel); got != d.want {
			t.Errorf("depthBelow(%q) = %d, want %d", d.rel, got, d.want)
		}
	}
}

// TestCheckAnnouncedSize: above 2^53 - 1, or above a known volume maximum,
// is file-too-large-for-folder; a volume maximum of 0 means none is known.
func TestCheckAnnouncedSize(t *testing.T) {
	rows := []struct {
		size, volumeMax int64
		code            RefusalCode
	}{
		{0, 0, ""},
		{4, fat32Max, ""},
		{fat32Max, fat32Max, ""},
		{fat32Max + 1, fat32Max, CodeFileTooLargeForFolder},
		{5 << 30, fat32Max, CodeFileTooLargeForFolder},
		{maxAnnouncedSize, 0, ""},
		{maxAnnouncedSize + 1, 0, CodeFileTooLargeForFolder},
	}
	for _, r := range rows {
		code, reason := checkAnnouncedSize(r.size, r.volumeMax)
		if code != r.code {
			t.Errorf("checkAnnouncedSize(%d, %d) = %q, want %q", r.size, r.volumeMax, code, r.code)
		}
		if code != "" && reason != CodeFileTooLargeForFolder.WireReason() {
			t.Errorf("checkAnnouncedSize(%d, %d) reason = %q", r.size, r.volumeMax, reason)
		}
	}
}

// TestCheckFirstMetadata: the checks that need no folder and so run before
// the owner is asked: the count, a present total, and file 1 first.
func TestCheckFirstMetadata(t *testing.T) {
	ok := FileInfo{FileName: "a.txt", FileSize: 4, Index: 1, Total: 10000, TotalBytes: 4}
	rows := []struct {
		name string
		edit func(*FileInfo)
		l    *ReceiveLimits
		code RefusalCode
	}{
		{"10000 files", func(*FileInfo) {}, requestLimits(), ""},
		{"10001 files", func(i *FileInfo) { i.Total = 10001 }, requestLimits(), CodeOverApproved},
		{"total bytes 0", func(i *FileInfo) { i.TotalBytes = 0; i.FileSize = 0 }, requestLimits(), CodeOverApproved},
		{"first is file 2", func(i *FileInfo) { i.Index = 2 }, requestLimits(), CodeOverApproved},
		{"MaxFiles 0 refuses everything", func(*FileInfo) {}, &ReceiveLimits{}, CodeOverApproved},
	}
	for _, r := range rows {
		info := ok
		r.edit(&info)
		code, reason := checkFirstMetadata(info, r.l)
		if code != r.code {
			t.Errorf("%s: code %q, want %q", r.name, code, r.code)
		}
		if code != "" && reason != CodeOverApproved.WireReason() {
			t.Errorf("%s: reason %q", r.name, reason)
		}
	}
}

// TestCheckEveryMetadata: the checks run immediately before each claim.
func TestCheckEveryMetadata(t *testing.T) {
	const reserve = 2 << 30
	first := FileInfo{FileName: "a.txt", FileSize: 10, Index: 1, Total: 3, TotalBytes: 30}
	next := first
	next.Index = 2
	rows := []struct {
		name          string
		info          FileInfo
		filesReceived int
		frames        int
		l             *ReceiveLimits
		free          int64
		code          RefusalCode
	}{
		{"first file", first, 0, 1, requestLimits(), -1, ""},
		{"second file", next, 1, 2, requestLimits(), -1, ""},
		{"total grows", FileInfo{FileSize: 10, Index: 2, Total: 4, TotalBytes: 30}, 1, 2, requestLimits(), -1, CodeOverApproved},
		{"total bytes grows", FileInfo{FileSize: 10, Index: 2, Total: 3, TotalBytes: 31}, 1, 2, requestLimits(), -1, CodeOverApproved},
		{"index skips", FileInfo{FileSize: 10, Index: 3, Total: 3, TotalBytes: 30}, 1, 2, requestLimits(), -1, CodeOverApproved},
		{"index repeats", first, 1, 2, requestLimits(), -1, CodeOverApproved},
		{"frames at MaxFiles", first, 0, 10000, requestLimits(), -1, ""},
		{"frames past MaxFiles", first, 0, 10001, requestLimits(), -1, CodeOverApproved},
		{"free exactly size plus reserve", first, 0, 1, requestLimits(), reserve + 10, ""},
		{"free one byte short", first, 0, 1, requestLimits(), reserve + 9, CodeDiskFull},
		{"free unknown", first, 0, 1, requestLimits(), -1, ""},
		{"negative reserve is none", first, 0, 1, &ReceiveLimits{MaxFiles: 10000, FreeReserve: -1}, 10, ""},
		{"negative reserve still needs the file", first, 0, 1, &ReceiveLimits{MaxFiles: 10000, FreeReserve: -1}, 9, CodeDiskFull},
	}
	for _, r := range rows {
		code, reason := checkEveryMetadata(r.info, first, r.filesReceived, r.frames, r.l, r.free)
		if code != r.code {
			t.Errorf("%s: code %q, want %q", r.name, code, r.code)
		}
		if code != "" && reason != code.WireReason() {
			t.Errorf("%s: reason %q, want %q", r.name, reason, code.WireReason())
		}
	}
}

// TestCheckFrame: bytes actually received, never an announced number, count
// against the approved total.
func TestCheckFrame(t *testing.T) {
	rows := []struct {
		received int64
		n        int
		approved int64
		code     RefusalCode
	}{
		{0, 10, 10, ""},
		{6, 4, 10, ""},
		{6, 5, 10, CodeOverApproved},
		{10, 0, 10, ""},
		{10, 1, 10, CodeOverApproved},
	}
	for _, r := range rows {
		if code, _ := checkFrame(r.received, r.n, r.approved); code != r.code {
			t.Errorf("checkFrame(%d, %d, %d) = %q, want %q", r.received, r.n, r.approved, code, r.code)
		}
	}
}

// TestDiskQueries: Windows answers both questions for a real folder (the test
// temp folder is NTFS, which has no maximum this code knows); every other GOOS
// answers "unknown", which makes the checks skip.
func TestDiskQueries(t *testing.T) {
	if fat32MaxFileSize != fat32Max {
		t.Fatalf("fat32MaxFileSize = %d, want %d", fat32MaxFileSize, fat32Max)
	}
	dir := t.TempDir()
	free, freeErr := diskFree(dir)
	max, maxErr := volumeMaxFileSize(dir)
	if runtime.GOOS != "windows" {
		if free != -1 || freeErr != nil || max != 0 || maxErr != nil {
			t.Fatalf("diskFree = %d, %v; volumeMaxFileSize = %d, %v; want -1, nil and 0, nil", free, freeErr, max, maxErr)
		}
		return
	}
	if freeErr != nil || free <= 0 {
		t.Fatalf("diskFree(%s) = %d, %v; want a positive count", dir, free, freeErr)
	}
	if maxErr != nil || max != 0 {
		t.Fatalf("volumeMaxFileSize(%s) = %d, %v; want 0 on NTFS", dir, max, maxErr)
	}
	if _, err := diskFree(filepath.Join(dir, "missing")); err == nil {
		t.Fatal("diskFree of a missing folder reported no error")
	}
}

// acceptingDecide counts its calls and accepts, the Decide a test hands a
// receive that must never ask it.
type acceptingDecide struct{ calls int }

func (a *acceptingDecide) decide(IncomingInfo) Decision {
	a.calls++
	return Decision{Kind: DecisionAccept}
}

// TestLimitsFileCountOverMaxRefusesOverApproved: a drop announcing 10,001
// files is refused over-approved before OnIncoming and Decide; 10,000 is not.
func TestLimitsFileCountOverMaxRefusesOverApproved(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	t.Run("10001", func(t *testing.T) {
		stubDisk(t, 0, 1<<40)
		d := &acceptingDecide{}
		run := runHostile(t, metaFor("a.txt", 4, 1, 10001, 4), []byte("abcd"), ReceiveOptions{Limits: requestLimits(), Decide: d.decide})
		if run.incoming != 0 || d.calls != 0 {
			t.Fatalf("incoming=%d decide=%d, want neither asked", run.incoming, d.calls)
		}
		wantRefused(t, run, CodeOverApproved, CodeOverApproved.WireReason())
	})
	t.Run("10000", func(t *testing.T) {
		stubDisk(t, 0, 1<<40)
		d := &acceptingDecide{}
		run := runHostile(t, metaFor("a.txt", 4, 1, 10000, 4), nil, ReceiveOptions{Limits: requestLimits(), Decide: d.decide})
		if !run.acked || run.refusal != nil || d.calls != 1 {
			t.Fatalf("acked=%v frame=%+v decide=%d, want 10000 files accepted", run.acked, run.refusal, d.calls)
		}
	})
}

// TestLimitsMetadataFramesCountAgainstMaxFiles (E-37): every metadata frame
// counts toward MaxFiles, whatever index it claims, so a sender cannot replay
// file 1 forever. The pure rows pin the counter itself (10,001 frames all
// claiming file 1 of 1); the loopback row is the attack: file 1 re-sent 10,001
// times with fresh nested paths, which today builds a folder tree per frame,
// is refused at the first replay and creates no tree at all.
func TestLimitsMetadataFramesCountAgainstMaxFiles(t *testing.T) {
	info := FileInfo{FileName: "t.txt", FileSize: 4, Index: 1, Total: 1, TotalBytes: 4}
	if code, _ := checkEveryMetadata(info, info, 0, 10000, requestLimits(), -1); code != "" {
		t.Fatalf("frame 10000 refused with %q", code)
	}
	if code, _ := checkEveryMetadata(info, info, 0, 10001, requestLimits(), -1); code != CodeOverApproved {
		t.Fatalf("frame 10001 = %q, want %q: metadata frames must count against MaxFiles", code, CodeOverApproved)
	}
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	stubDisk(t, 0, 1<<40)
	d := &acceptingDecide{}
	run := runScripted(t, t.TempDir(), metaFor("t0.txt", 4, 1, 1, 4), ReceiveOptions{Limits: requestLimits(), Decide: d.decide},
		func(h *handSender, n int) {
			if n != 1 {
				return
			}
			for i := 1; i <= 10000; i++ {
				h.text(metaFor(fmt.Sprintf("t%d/a/b/c.txt", i), 4, 1, 1, 4))
			}
		})
	if d.calls != 1 {
		t.Fatalf("Decide asked %d times, want once", d.calls)
	}
	wantFrame(t, run, CodeOverApproved, CodeOverApproved.WireReason(), 0)
	if len(run.tree) != 0 {
		t.Fatalf("the output folder holds %v; the replays may create nothing and the open file's .part is removed", run.tree)
	}
}

// TestLimitsSecondMetadataWhileOpenRefuses (E-37): with limits set, a new
// metadata while a file is still open refuses over-approved, and the open
// file's .part is removed. The second frame claims file 1 again so the index
// check has nothing to say: only the open file refuses it.
func TestLimitsSecondMetadataWhileOpenRefuses(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	stubDisk(t, 0, 1<<40)
	run := runScripted(t, t.TempDir(), metaFor("a.txt", 8, 1, 2, 16), ReceiveOptions{Limits: requestLimits()},
		func(h *handSender, n int) {
			if n == 1 {
				h.bytes([]byte("abcd"))
				h.text(metaFor("b.txt", 8, 1, 2, 16))
			}
		})
	if run.acked && run.refusal == nil {
		t.Fatal("the second metadata was acked")
	}
	wantFrame(t, run, CodeOverApproved, CodeOverApproved.WireReason(), 0)
	if len(run.tree) != 0 {
		t.Fatalf("the output folder holds %v; the abandoned .part must be removed", run.tree)
	}
}

// TestLimitsTotalMustStayConstantAndIndexInOrder: after file 1 of 2 commits,
// the next metadata must keep both totals and be file 2.
func TestLimitsTotalMustStayConstantAndIndexInOrder(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	rows := []struct {
		name  string
		next  string
		ok    bool
		index int64
	}{
		{"in order", metaFor("b.txt", 4, 2, 2, 8), true, 2},
		{"total grows", metaFor("b.txt", 4, 2, 3, 8), false, 2},
		{"total bytes grows", metaFor("b.txt", 4, 2, 2, 9), false, 2},
		{"index skips", metaFor("b.txt", 4, 3, 2, 8), false, 3},
		{"index repeats", metaFor("b.txt", 4, 1, 2, 8), false, 1},
		// Nested, so a check that ran after MkdirAll would leave the folders
		// behind (WP-A1 review L1).
		{"index repeats nested", metaFor("t1/a/b/c.txt", 4, 1, 2, 8), false, 1},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			stubDisk(t, 0, 1<<40)
			run := runScripted(t, t.TempDir(), metaFor("a.txt", 4, 1, 2, 8), ReceiveOptions{Limits: requestLimits()},
				func(h *handSender, n int) {
					switch n {
					case 1:
						h.bytes([]byte("abcd"))
						h.text(`{"type":"end"}`)
						h.text(row.next)
					case 2:
						h.bytes([]byte("efgh"))
						h.text(`{"type":"end"}`)
					}
				})
			if row.ok {
				wantSaved(t, run, "a.txt", "b.txt")
				return
			}
			wantFrame(t, run, CodeOverApproved, CodeOverApproved.WireReason(), 1)
			if strings.Join(run.tree, "|") != "a.txt" {
				t.Fatalf("output tree %v, want only the committed a.txt", run.tree)
			}
		})
	}
	t.Run("first metadata is not file 1", func(t *testing.T) {
		stubDisk(t, 0, 1<<40)
		d := &acceptingDecide{}
		run := runHostile(t, metaFor("b.txt", 4, 2, 2, 8), []byte("efgh"), ReceiveOptions{Limits: requestLimits(), Decide: d.decide})
		if run.incoming != 0 || d.calls != 0 {
			t.Fatalf("incoming=%d decide=%d, want neither asked", run.incoming, d.calls)
		}
		wantRefused(t, run, CodeOverApproved, CodeOverApproved.WireReason())
	})
}

// TestLimitsAnnouncedTotalZeroRefused: a request-link drop must announce its
// total (a pre-1.6.0 sender cannot use a link anyway); zero or absent is
// refused before OnIncoming and Decide.
func TestLimitsAnnouncedTotalZeroRefused(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	rows := []struct{ name, meta string }{
		{"zero", metaFor("a.txt", 0, 1, 1, 0)},
		{"absent", `{"type":"metadata","id":"z","fileName":"a.txt","fileSize":4,"index":1,"total":1,"pv":1,"pvMin":1}`},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			stubDisk(t, 0, 1<<40)
			d := &acceptingDecide{}
			run := runHostile(t, row.meta, []byte("abcd"), ReceiveOptions{Limits: requestLimits(), Decide: d.decide})
			if run.incoming != 0 || d.calls != 0 {
				t.Fatalf("incoming=%d decide=%d, want neither asked", run.incoming, d.calls)
			}
			wantRefused(t, run, CodeOverApproved, CodeOverApproved.WireReason())
		})
	}
}

// TestLimitsBytesReceivedPastApprovedRefusedMidFileNoPart (VR2-05): the
// approved total is the first metadata's, and only bytes that actually arrive
// count against it. Each file below stays inside its own announced size and
// inside the announced total, yet the second one crosses the approved total
// mid-file: the frame that crosses is refused, its .part is removed, and the
// committed first file stays.
func TestLimitsBytesReceivedPastApprovedRefusedMidFileNoPart(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	stubDisk(t, 0, 1<<40)
	run := runScripted(t, t.TempDir(), metaFor("a.bin", 6, 1, 2, 10), ReceiveOptions{Limits: requestLimits()},
		func(h *handSender, n int) {
			switch n {
			case 1:
				h.bytes([]byte("aaaaaa"))
				h.text(`{"type":"end"}`)
				h.text(metaFor("b.bin", 10, 2, 2, 10))
			case 2:
				if err := h.sender.Send([]byte("bbbb")); err != nil {
					t.Errorf("send: %v", err)
				}
				if err := h.sender.Send([]byte("bb")); err != nil {
					t.Errorf("send: %v", err)
				}
			}
		})
	wantFrame(t, run, CodeOverApproved, CodeOverApproved.WireReason(), 1)
	if strings.Join(run.tree, "|") != "a.bin" {
		t.Fatalf("output tree %v, want only the committed a.bin and no .part", run.tree)
	}
}

// TestLimitsFreeSpaceBelowReserveRefusesBeforeAck: the free-space check needs
// the folder the owner accepted, so it runs after Decide, against that folder,
// and before the claim and the ack. One byte short of the file plus the 2 GiB
// reserve refuses disk-full; exactly enough is acked. The nested name makes a
// check that ran after MkdirAll visible: its folders would stay behind (WP-A1
// review L1).
func TestLimitsFreeSpaceBelowReserveRefusesBeforeAck(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	for _, c := range []struct {
		free int64
		name string
	}{
		{(2 << 30) + 3, "a.txt"},
		{(2 << 30) + 4, "a.txt"},
		{(2 << 30) + 3, "sub/deeper/a.txt"},
	} {
		free, name := c.free, c.name
		t.Run(fmt.Sprint(free, " ", name), func(t *testing.T) {
			disk := stubDisk(t, 0, free)
			dir := t.TempDir()
			drop := filepath.Join(dir, "drop")
			askedBeforeDecide := -1
			opts := ReceiveOptions{
				Limits: requestLimits(),
				Decide: func(IncomingInfo) Decision {
					askedBeforeDecide = len(disk.asked())
					if err := os.Mkdir(drop, 0o755); err != nil {
						t.Errorf("mkdir drop: %v", err)
					}
					return Decision{Kind: DecisionAccept, OutputDir: drop}
				},
			}
			run := runHostileIn(t, dir, metaFor(name, 4, 1, 1, 4), nil, opts)
			if askedBeforeDecide != 0 {
				t.Fatalf("free space was asked %d times before Decide", askedBeforeDecide)
			}
			if got := disk.asked(); len(got) != 1 || got[0] != drop {
				t.Fatalf("free space asked for %v, want exactly the accepted folder %s", got, drop)
			}
			if free == (2<<30)+4 {
				if !run.acked || run.refusal != nil {
					t.Fatalf("acked=%v frame=%+v, want exactly enough space acked", run.acked, run.refusal)
				}
				return
			}
			if run.acked {
				t.Fatal("the receiver acked a file the drive has no room for")
			}
			wantFrame(t, run, CodeDiskFull, CodeDiskFull.WireReason(), 0)
			if strings.Join(run.tree, "|") != "drop/" {
				t.Fatalf("output tree %v, want only the empty folder Decide made", run.tree)
			}
		})
	}
}

// TestLimitsRunBeforeDecide: a Decide that would accept is never called for a
// drop the first-metadata checks refuse, so the owner is never asked about a
// drop the receiver would refuse anyway. Layer 1 runs there too.
func TestLimitsRunBeforeDecide(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	rows := []struct {
		name, meta string
		code       RefusalCode
		reason     string
	}{
		{"10001 files", metaFor("a.txt", 4, 1, 10001, 4), CodeOverApproved, CodeOverApproved.WireReason()},
		{"total bytes 0", metaFor("a.txt", 0, 1, 1, 0), CodeOverApproved, CodeOverApproved.WireReason()},
		{"file 2 first", metaFor("a.txt", 4, 2, 2, 8), CodeOverApproved, CodeOverApproved.WireReason()},
		{"depth 33", metaFor(strings.Repeat("d/", 32)+"f.txt", 4, 1, 1, 4), CodePathTooLong, CodePathTooLong.WireReason()},
		{"drive path", metaFor(`C:\x.txt`, 4, 1, 1, 4), CodePathTooLong, reasonPathNotRelative},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			disk := stubDisk(t, 0, 1<<40)
			d := &acceptingDecide{}
			run := runHostile(t, row.meta, []byte("abcd"), ReceiveOptions{Limits: requestLimits(), Decide: d.decide})
			if d.calls != 0 {
				t.Fatalf("Decide was asked %d times about a drop the receiver refuses", d.calls)
			}
			if run.incoming != 0 {
				t.Fatalf("OnIncoming fired %d times", run.incoming)
			}
			if len(disk.asked()) != 0 {
				t.Fatalf("free space was asked for %v", disk.asked())
			}
			wantRefused(t, run, row.code, row.reason)
		})
	}
}

// TestNilLimitsKeepsLayer2Off: with Limits nil, the plain CLI and code
// receive, nothing of layer 2 runs: 10,001 files and a missing total are
// acked, a repeated metadata while a file is open restarts as it always has,
// and free space is never asked, even from a stub that would refuse all.
func TestNilLimitsKeepsLayer2Off(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	disk := stubDisk(t, 0, 0)
	for _, meta := range []string{metaFor("a.txt", 4, 1, 10001, 4), metaFor("a.txt", 4, 1, 1, 0)} {
		run := runHostile(t, meta, nil, ReceiveOptions{})
		if !run.acked || run.refusal != nil {
			t.Fatalf("%s: acked=%v frame=%+v, want an ack", meta, run.acked, run.refusal)
		}
	}
	run := runScripted(t, t.TempDir(), metaFor("a.txt", 4, 1, 1, 4), ReceiveOptions{},
		func(h *handSender, n int) {
			switch n {
			case 1:
				h.bytes([]byte("ab"))
				h.text(metaFor("b.txt", 4, 1, 1, 4))
			case 2:
				h.bytes([]byte("abcd"))
				h.text(`{"type":"end"}`)
			}
		})
	wantSaved(t, run, "b.txt")
	if got := disk.asked(); len(got) != 0 {
		t.Fatalf("free space was asked for %v with Limits nil", got)
	}
}

// TestNestedFoldersRebuildInsideOutputDir (VR2-07): a real Go sender's folder
// arrives with its relative paths rebuilt inside the accepted folder, and an
// empty folder, which carries no file, is not delivered.
func TestNestedFoldersRebuildInsideOutputDir(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	stubDisk(t, 0, 1<<40)
	p := newOffererPair(t, nil)
	src := t.TempDir()
	for _, rel := range []string{"album/2024/june/a.jpg", "album/2024/b.jpg", "album/c.jpg"} {
		writeRandom(t, src, rel, 700)
	}
	if err := os.MkdirAll(filepath.Join(src, "album", "empty"), 0o755); err != nil {
		t.Fatal(err)
	}

	out := t.TempDir()
	drop := filepath.Join(out, "drop")
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- ReceiveFilesWithOptions(p.host, out, true, "test-ver", "", ReceiveOptions{
			Limits: requestLimits(),
			Decide: func(IncomingInfo) Decision {
				if err := os.Mkdir(drop, 0o755); err != nil {
					return Decision{Kind: DecisionRefuse, Code: CodeWriteFailed}
				}
				return Decision{Kind: DecisionAccept, OutputDir: drop}
			},
			Messages: p.hostMsgs,
			Closed:   p.hostClosed,
		})
	}()
	sendErr := make(chan error, 1)
	go func() {
		sendErr <- SendFilesWithOptions(p.visitor, []string{filepath.Join(src, "album")}, "test-ver", SendOptions{
			Messages: p.visitorMsgs,
			Closed:   p.visitorClosed,
		})
	}()
	p.finish(t, sendErr, recvErr, 60*time.Second)

	want := []string{"drop/", "drop/album/", "drop/album/2024/", "drop/album/2024/b.jpg", "drop/album/2024/june/", "drop/album/2024/june/a.jpg", "drop/album/c.jpg"}
	if got := treeOf(t, out); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("output tree %v, want %v", got, want)
	}
}
