package transfer

// PrecheckDrop: the request-link send's file-count and metadata-size checks,
// made on the sender's own files before any network (TL-30, TL-31).

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// TestPrecheckDropTooManyFiles: exactly MaxDropFiles passes and one more is
// refused, through the pure helper so no test makes ten thousand files.
func TestPrecheckDropTooManyFiles(t *testing.T) {
	entries := make([]fileEntry, MaxDropFiles+1)
	for i := range entries {
		entries[i] = fileEntry{displayName: fmt.Sprintf("shoot/f%05d.bin", i), size: 1}
	}
	if n, err := precheckEntries(entries[:MaxDropFiles], "1.10.11"); err != nil || n != MaxDropFiles {
		t.Fatalf("%d files: (%d, %v), want (%d, nil)", MaxDropFiles, n, err, MaxDropFiles)
	}
	n, err := precheckEntries(entries, "1.10.11")
	if !errors.Is(err, ErrTooManyFiles) || n != MaxDropFiles+1 {
		t.Fatalf("%d files: (%d, %v), want (%d, ErrTooManyFiles)", MaxDropFiles+1, n, err, MaxDropFiles+1)
	}
}

// TestPrecheckDropMetadataBoundary: a frame of exactly controlMsgMax bytes
// (1000) is allowed and 1001 is refused, measured as the wire measures it, with
// JSON's escapes counted: the name holds quotes, backslashes and characters
// outside the BMP, which cost two, two and four bytes.
func TestPrecheckDropMetadataBoundary(t *testing.T) {
	const ver = "1.10.11"
	base := `shoot/"take" \ 2 😀 𝄞 `
	frame := func(name string) int {
		return metadataFrameLen(fileEntry{displayName: name, size: 4096}, 1, 4096, ver)
	}
	// The measure is the escaped length, not the name's: one quote in place
	// of a letter costs one more byte, one backslash one more, and one astral
	// character three more. <, > and & cost no more than a letter: the wire
	// does not HTML-escape them (T13-F2).
	for _, c := range []struct {
		swap  string
		extra int
	}{{`"`, 1}, {`\`, 1}, {"😀", 3}, {"&", 0}, {"<", 0}, {">", 0}} {
		if got := frame("a"+c.swap) - frame("aa"); got != c.extra {
			t.Fatalf("%q costs %d bytes over a letter, want %d", c.swap, got, c.extra)
		}
	}
	pad := controlMsgMax - frame(base)
	if pad < 1 {
		t.Fatalf("the fixture's base frame is already %d bytes", frame(base))
	}
	at := base + strings.Repeat("a", pad)
	if got := frame(at); got != controlMsgMax {
		t.Fatalf("padded frame is %d bytes, want exactly %d", got, controlMsgMax)
	}
	if _, err := precheckEntries([]fileEntry{{displayName: at, size: 4096}}, ver); err != nil {
		t.Fatalf("a %d-byte frame was refused: %v", controlMsgMax, err)
	}
	over := at + "a"
	if _, err := precheckEntries([]fileEntry{{displayName: over, size: 4096}}, ver); !errors.Is(err, ErrMetadataTooLarge) {
		t.Fatalf("a %d-byte frame gave %v, want ErrMetadataTooLarge", controlMsgMax+1, err)
	}

	// The measure is what sendFile will put on the wire for that file: the
	// same struct with a real uuid is the same length, and it is JSON.
	real := metadataJSON(metadataMsg{
		Type: "metadata", ID: uuid.New().String(), FileName: at, FileSize: 4096, Index: 1, Total: 1,
		TotalBytes: 4096, Pv: ProtocolVersion, PvMin: MinProtocolVersion, Ver: ver,
	})
	var back metadataMsg
	if err := json.Unmarshal(real, &back); err != nil || len(real) != controlMsgMax || back.FileName != at {
		t.Fatalf("sendFile's own frame for the boundary name is %d bytes (%v, name back %q), want %d", len(real), err, back.FileName, controlMsgMax)
	}

	// A legal Windows name of 150 ampersands (T13 K3amp) fits now; with
	// json.Marshal's six-byte escape for each & its frame was 1,075 bytes and
	// the send refused it.
	amp := strings.Repeat("&", 150) + ".txt"
	if got := frame(amp); got > controlMsgMax {
		t.Fatalf("the ampersand name's frame is %d bytes, over %d", got, controlMsgMax)
	}
	if _, err := precheckEntries([]fileEntry{{displayName: amp, size: 4096}}, ver); err != nil {
		t.Fatalf("the ampersand name was refused: %v", err)
	}
	if w := metadataJSON(metadataMsg{Type: "metadata", FileName: amp}); bytes.Contains(w, []byte{92, 'u', '0', '0', '2', '6'}) {
		t.Fatalf("the wire frame HTML-escapes &: %s", w)
	}

	// The widest index is the one measured: a name exactly at the cap as file
	// 9 of 9 is two bytes over it in a 10-file drop, whose index and total are
	// a digit wider each. Empty files, so the batch size cannot move too.
	nine := make([]fileEntry, 9)
	for i := range nine {
		nine[i] = fileEntry{displayName: "x"}
	}
	nine[0].displayName = strings.Repeat("a", controlMsgMax-metadataFrameLen(fileEntry{}, 9, 0, ver))
	if got := metadataFrameLen(nine[0], 9, 0, ver); got != controlMsgMax {
		t.Fatalf("the 9-file fixture is %d bytes, want %d", got, controlMsgMax)
	}
	if _, err := precheckEntries(nine, ver); err != nil {
		t.Fatalf("a name at the cap in a 9-file drop was refused: %v", err)
	}
	ten := append(nine, fileEntry{displayName: "x"})
	if _, err := precheckEntries(ten, ver); !errors.Is(err, ErrMetadataTooLarge) {
		t.Fatalf("the same name in a 10-file drop gave %v, want ErrMetadataTooLarge (two more index digits)", err)
	}
}

// TestPrecheckDropWalksLikeTheSend: PrecheckDrop counts what collectFiles
// finds, folders walked, and fails as the send would on a path that is gone
// and on a folder with nothing in it.
func TestPrecheckDropWalksLikeTheSend(t *testing.T) {
	dir := t.TempDir()
	shoot := filepath.Join(dir, "shoot")
	if err := os.MkdirAll(filepath.Join(shoot, "audio"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a.mov", "b.mov", filepath.Join("audio", "c.wav")} {
		if err := os.WriteFile(filepath.Join(shoot, name), []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	single := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(single, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if n, err := PrecheckDrop([]string{shoot, single}, "1.10.11"); err != nil || n != 4 {
		t.Fatalf("PrecheckDrop = (%d, %v), want (4, nil)", n, err)
	}

	var pathErr *fs.PathError
	if _, err := PrecheckDrop([]string{filepath.Join(dir, "missing.mov")}, "1.10.11"); !errors.As(err, &pathErr) {
		t.Fatalf("a missing path gave %v, want the walk's *fs.PathError", err)
	}
	empty := filepath.Join(dir, "empty")
	if err := os.Mkdir(empty, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := PrecheckDrop([]string{empty}, "1.10.11"); !errors.Is(err, ErrNoFiles) || err.Error() != "no files to send" {
		t.Fatalf("an empty folder gave %v, want the send's own \"no files to send\"", err)
	}
}

// TestTheThreeWalksNameAnEmptyTreeAlike: PrecheckDrop, Summarize and the send
// itself all return ErrNoFiles for a tree with no file, in the words each has
// always used, so the request-link send can tell a tree emptied between its
// walks from a lost connection (review lens A, nit 7). The send returns
// before it touches the channel, so none is needed here.
func TestTheThreeWalksNameAnEmptyTreeAlike(t *testing.T) {
	empty := t.TempDir()
	_, pre := PrecheckDrop([]string{empty}, "1.10.11")
	_, sum := Summarize([]string{empty})
	send := SendFilesWithOptions(nil, []string{empty}, "1.10.11", SendOptions{})
	for name, err := range map[string]error{"PrecheckDrop": pre, "Summarize": sum, "SendFilesWithOptions": send} {
		if !errors.Is(err, ErrNoFiles) || err.Error() != "no files to send" {
			t.Errorf("%s on an empty tree = %v, want ErrNoFiles as \"no files to send\"", name, err)
		}
	}
}

// TestMaxDropFilesMatchesTheOtherSurfaces pins the cap to the host's and the
// /r page's, read from their sources, so none of the three can move alone.
func TestMaxDropFilesMatchesTheOtherSurfaces(t *testing.T) {
	if MaxDropFiles != 10000 {
		t.Fatalf("MaxDropFiles = %d, want 10000", MaxDropFiles)
	}
	for _, c := range []struct {
		file string
		re   *regexp.Regexp
	}{
		{"../../../client/lib/request/constants.ts", regexp.MustCompile(`MAX_REQUEST_FILES\s*=\s*10_000;`)},
		{"../../../desktop/transfer.go", regexp.MustCompile(`requestMaxFiles\s*=\s*10000\b`)},
	} {
		src, err := os.ReadFile(filepath.FromSlash(c.file))
		if err != nil {
			t.Fatalf("read %s: %v", c.file, err)
		}
		if !c.re.Match(src) {
			t.Fatalf("%s no longer says %s", c.file, c.re)
		}
	}
}
