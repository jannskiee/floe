package selfupdate

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCompareVersions(t *testing.T) {
	tests := []struct {
		a, b string
		want int
	}{
		{"v1.2.0", "v1.1.0", 1},
		{"v1.0.0", "v1.0.0", 0},
		{"v1.0.0", "v1.1.0", -1},
		{"v2.0.0", "v1.9.9", 1},
		{"v1.0.1", "v1.0.0", 1},
		{"v0.9.0", "v1.0.0", -1},
		{"1.2.0", "v1.2.0", 0},   // no "v" prefix
		{"v10.0.0", "v9.9.9", 1}, // double-digit major
	}
	for _, tt := range tests {
		if got := CompareVersions(tt.a, tt.b); got != tt.want {
			t.Errorf("CompareVersions(%q, %q) = %d, want %d", tt.a, tt.b, got, tt.want)
		}
	}
}

func TestAssetName(t *testing.T) {
	tests := []struct {
		goos, goarch, version string
		wantName              string
		wantFmt               string
	}{
		{"linux", "amd64", "v1.2.0", "floe_1.2.0_linux_amd64.tar.gz", "tar.gz"},
		{"linux", "arm64", "v1.2.0", "floe_1.2.0_linux_arm64.tar.gz", "tar.gz"},
		{"darwin", "amd64", "v1.2.0", "floe_1.2.0_darwin_amd64.tar.gz", "tar.gz"},
		{"darwin", "arm64", "v1.2.0", "floe_1.2.0_darwin_arm64.tar.gz", "tar.gz"},
		{"windows", "amd64", "v1.2.0", "floe_1.2.0_windows_amd64.zip", "zip"},
		{"windows", "arm64", "v1.2.0", "floe_1.2.0_windows_arm64.zip", "zip"},
		// A bare version (no leading "v") must produce the same asset name.
		{"linux", "amd64", "1.2.0", "floe_1.2.0_linux_amd64.tar.gz", "tar.gz"},
	}
	for _, tt := range tests {
		gotName, gotFmt := AssetName(tt.version, tt.goos, tt.goarch)
		if gotName != tt.wantName {
			t.Errorf("AssetName(%q, %q, %q): name = %q, want %q", tt.version, tt.goos, tt.goarch, gotName, tt.wantName)
		}
		if gotFmt != tt.wantFmt {
			t.Errorf("AssetName(%q, %q, %q): format = %q, want %q", tt.version, tt.goos, tt.goarch, gotFmt, tt.wantFmt)
		}
	}
}

func TestDetectPM(t *testing.T) {
	tests := []struct {
		path string
		want string
	}{
		{"/opt/homebrew/Cellar/floe/1.0.0/bin/floe", "homebrew"},
		{"/usr/local/Cellar/floe/1.0.0/bin/floe", "homebrew"},
		// Homebrew's default folder on an Intel Mac, where the cask's file sits
		// under a path with neither "homebrew" nor "cellar" in it.
		{"/usr/local/Caskroom/floe/1.11.0/floe", "homebrew"},
		{"/home/linuxbrew/.linuxbrew/bin/floe", "homebrew"},
		{"C:/Users/user/scoop/apps/floe/current/floe.exe", "scoop"},
		{"C:/Users/user/AppData/Local/Microsoft/WinGet/Packages/jannskiee.floe/floe.exe", "winget"},
		{"/usr/local/bin/floe", ""},
		{"/home/user/.local/bin/floe", ""},
		{"/home/user/bin/floe", ""},
		{"C:/Users/user/AppData/Local/Programs/floe/floe.exe", ""},
	}
	for _, tt := range tests {
		if got := DetectPM(tt.path); got != tt.want {
			t.Errorf("DetectPM(%q) = %q, want %q", tt.path, got, tt.want)
		}
	}
}

// TestPMForReadsTheFileTheCommandLinksTo: the package manager is read from
// the path the process was started from and from the file that path resolves
// to. On macOS os.Executable reports the command as it was run, links
// unresolved, and Homebrew on an Intel Mac puts that command at
// /usr/local/bin/floe, a link into /usr/local/Caskroom, so only the resolved
// path names Homebrew. A command that is no link, and one whose link cannot be
// read, are judged by their own path alone.
func TestPMForReadsTheFileTheCommandLinksTo(t *testing.T) {
	links := map[string]string{
		"/usr/local/bin/floe":      "/usr/local/Caskroom/floe/1.11.0/floe",
		"/home/user/.local/bin/f":  "/home/user/.local/bin/f",
		"/opt/homebrew/bin/floe":   "/nowhere/floe",
		"/usr/local/bin/floe-self": "/usr/local/lib/floe/floe",
	}
	resolve := func(p string) (string, error) {
		if to, ok := links[p]; ok {
			return to, nil
		}
		return "", os.ErrNotExist
	}
	tests := []struct {
		exe  string
		want string
	}{
		{"/usr/local/bin/floe", "homebrew"},
		{"/home/user/.local/bin/f", ""},
		// Named by the command's own path: the link is never needed.
		{"/opt/homebrew/bin/floe", "homebrew"},
		{"/usr/local/bin/floe-self", ""},
		{"/usr/local/bin/unreadable-link", ""},
	}
	for _, tt := range tests {
		if got := pmFor(tt.exe, resolve); got != tt.want {
			t.Errorf("pmFor(%q) = %q, want %q", tt.exe, got, tt.want)
		}
	}
}

// TestPMForFollowsARealLink is the same rule through filepath.EvalSymlinks,
// the resolver PMPath passes, on a link made on disk in the shape of an Intel
// Mac's Homebrew. Skipped where this account may not make a link (Windows
// without Developer Mode) and where the temp folder's own path already reads
// as package-managed.
func TestPMForFollowsARealLink(t *testing.T) {
	root := t.TempDir()
	if pm := DetectPM(root); pm != "" {
		t.Skipf("the temp folder %q reads as %s on its own", root, pm)
	}
	target := filepath.Join(root, "usr", "local", "Caskroom", "floe", "1.11.0", "floe")
	link := filepath.Join(root, "usr", "local", "bin", "floe")
	for _, p := range []string{target, link} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(target, []byte("floe"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("cannot make a link here: %v", err)
	}
	if got := pmFor(link, filepath.EvalSymlinks); got != "homebrew" {
		t.Errorf("pmFor(%q) = %q, want homebrew: the file it links to is under Caskroom", link, got)
	}
	if got := pmFor(target, filepath.EvalSymlinks); got != "homebrew" {
		t.Errorf("pmFor(%q) = %q, want homebrew", target, got)
	}
}

func TestPMHint(t *testing.T) {
	tests := []struct {
		pm   string
		want string
	}{
		{"homebrew", "brew upgrade floe"},
		{"scoop", "scoop update floe"},
		{"winget", "winget upgrade jannskiee.floe"},
		{"", ""},
		{"unknown", ""},
	}
	for _, tt := range tests {
		if got := PMHint(tt.pm); got != tt.want {
			t.Errorf("PMHint(%q) = %q, want %q", tt.pm, got, tt.want)
		}
	}
}

func TestInstallBinaryReplacesInPlace(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "floe")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	if err := os.WriteFile(exe, []byte("OLD BINARY"), 0o755); err != nil {
		t.Fatal(err)
	}

	// The new binary is staged in the OS temp dir, exactly like Apply does.
	newBin := filepath.Join(t.TempDir(), "floe-update")
	if err := os.WriteFile(newBin, []byte("NEW BINARY"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := installBinary(exe, newBin); err != nil {
		t.Fatalf("installBinary: %v", err)
	}

	got, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "NEW BINARY" {
		t.Errorf("installed content = %q, want %q", got, "NEW BINARY")
	}

	// The installed binary must be executable, even though the source was 0644.
	if runtime.GOOS != "windows" {
		info, err := os.Stat(exe)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o111 == 0 {
			t.Errorf("installed binary not executable: mode %v", info.Mode().Perm())
		}
	}

	// No staging leftovers should remain in the install dir.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != filepath.Base(exe) {
			t.Errorf("unexpected leftover in install dir: %s", e.Name())
		}
	}
}

// TestWindowsUpdateBackupIsFloesOwnName (CLI-03): the Windows update moves the
// running image aside under a name only floe makes, and the start cleanup
// removes that name and nothing else. A person's own floe.exe.bak survives a
// start; an update still clears the .bak that earlier versions left, as it
// always did before its rename. windowsInstall runs on every OS here: it is
// renames and copies only.
func TestWindowsUpdateBackupIsFloesOwnName(t *testing.T) {
	if got, want := updateBackupPath(`C:\Tools\floe.exe`), `C:\Tools\floe.exe.floe-update-old`; got != want {
		t.Fatalf("updateBackupPath = %q, want %q", got, want)
	}

	dir := t.TempDir()
	exe := filepath.Join(dir, "floe.exe")
	write := func(p, body string) {
		t.Helper()
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// The start cleanup: its own name goes, a hand-kept .bak stays.
	write(exe, "NEW BINARY")
	write(exe+".floe-update-old", "OLD BINARY")
	write(exe+".bak", "A COPY KEPT BY HAND")
	removeUpdateBackup(exe)
	if _, err := os.Stat(exe + ".floe-update-old"); !os.IsNotExist(err) {
		t.Fatalf("the start cleanup left the update's old image (stat err %v)", err)
	}
	if got, err := os.ReadFile(exe + ".bak"); err != nil || string(got) != "A COPY KEPT BY HAND" {
		t.Fatalf("the start cleanup touched floe.exe.bak: %q, %v", got, err)
	}

	// The update: a leftover of either name is cleared, the new binary is in
	// place, and nothing else is left (this process does not run from exe,
	// so the old image's delete succeeds).
	write(exe+".floe-update-old", "AN EARLIER OLD BINARY")
	newBin := filepath.Join(t.TempDir(), "floe-update")
	write(newBin, "NEWER BINARY")
	if err := windowsInstall(exe, newBin); err != nil {
		t.Fatalf("windowsInstall: %v", err)
	}
	if got, err := os.ReadFile(exe); err != nil || string(got) != "NEWER BINARY" {
		t.Fatalf("installed %q, %v", got, err)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != "floe.exe" {
			t.Errorf("unexpected leftover beside floe.exe: %s", e.Name())
		}
	}
}

func TestCopyFileSetsMode(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	dst := filepath.Join(dir, "dst")
	if err := os.WriteFile(src, []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := copyFile(src, dst, 0o755); err != nil {
		t.Fatalf("copyFile: %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "data" {
		t.Errorf("content = %q, want %q", got, "data")
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(dst)
		if info.Mode().Perm() != 0o755 {
			t.Errorf("mode = %v, want 0755", info.Mode().Perm())
		}
	}
}

// A future checked_at must be a miss. Without the guard time.Since is negative,
// the "> cacheTTL" test is false, and the entry never expires: the update check
// stays off until wall time catches up to whatever was written. The desktop's
// twin in desktop/updatecheck.go has always had this.
func TestFromCacheRejectsAFutureTimestamp(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	if runtime.GOOS == "windows" {
		t.Setenv("AppData", dir)
	}
	p := cacheFilePath()
	if p == "" {
		t.Skip("no user config dir on this machine")
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	write := func(at time.Time) {
		b, err := json.Marshal(cacheEntry{CheckedAt: at, Latest: "v9.9.9"})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	write(time.Now().Add(-time.Minute))
	if got, ok := fromCache(); !ok || got != "v9.9.9" {
		t.Fatalf("a fresh entry should hit: got %q ok=%v", got, ok)
	}

	write(time.Now().Add(72 * time.Hour))
	if _, ok := fromCache(); ok {
		t.Fatal("a future checked_at was treated as a hit; the update check would stay pinned off")
	}
}

// TestChecksumMismatchKeepsItsLines (FU-43 review 2 M3): the mismatch is a
// multi-line error Floe writes itself, so it carries the OwnLines mark the
// CLI's error printer needs to print it as lines rather than on one.
func TestChecksumMismatchKeepsItsLines(t *testing.T) {
	file := filepath.Join(t.TempDir(), "floe.zip")
	if err := os.WriteFile(file, []byte("not the release"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := verifySHA256(file, "floe.zip", "0000000000000000000000000000000000000000000000000000000000000000  floe.zip\n")
	if err == nil {
		t.Fatal("verifySHA256 accepted a file whose hash is not listed")
	}
	if _, ok := err.(interface{ OwnLines() }); !ok {
		t.Errorf("the checksum mismatch does not mark its lines as Floe's own: %T %q", err, err)
	}
	if n := strings.Count(err.Error(), "\n"); n != 2 {
		t.Errorf("the checksum mismatch has %d newlines, want 2: %q", n, err)
	}
}

// TestDownloadTempLeavesNoFileWhenTheBodyFails: a download whose body fails
// partway removes its temp file. Windows refuses to delete a file this process
// still has open, and downloadTemp used to try before its deferred Close, so
// every failed `floe update` download there left a partial floe-update-* file
// in the temp directory. The transport is in memory: no network.
func TestDownloadTempLeavesNoFileWhenTheBodyFails(t *testing.T) {
	prev := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = prev })
	http.DefaultTransport = roundTripperFunc(func(r *http.Request) (*http.Response, error) {
		body := io.MultiReader(strings.NewReader("the first bytes of a release"), failingReader{})
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(body), Request: r}, nil
	})
	pattern := filepath.Join(os.TempDir(), "floe-update-*")
	before, _ := filepath.Glob(pattern)
	if _, err := downloadTemp("https://download.invalid/floe.zip"); err == nil {
		t.Fatal("downloadTemp succeeded on a body that failed partway")
	}
	if after, _ := filepath.Glob(pattern); len(after) != len(before) {
		t.Fatalf("the failed download left a temp file behind: %v", after)
	}
}

// roundTripperFunc is an http.RoundTripper made of a function.
type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// failingReader is a body that breaks, as a connection that drops mid-download.
type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("connection reset mid-download") }

// unexpectedTagLine is the fixed line floe update stops with, typed out here so
// a test fails if the sentence changes.
const unexpectedTagLine = "The latest release has an unexpected version name, so floe update stopped. Reinstall with the steps at floe.one/docs/cli/installation instead."

// goodTags are release tags as the release process makes them.
var goodTags = []string{"v0.0.0", "v0.1.0", "v1.2.3", "v1.11.7", "v10.20.30"}

type namedTag struct{ name, tag string }

// hostileTags is every shape of name a release could carry that must never reach
// a download URL, the cache or the output. The empty tag is not here: it is
// everyBadTag's, because LatestVersion has its own check for that one.
func hostileTags() []namedTag {
	return []namedTag{
		{"no leading v", "9.9.9"},
		{"two numbers", "v1.2"},
		{"one number", "v9"},
		{"four numbers", "v1.2.3.4"},
		{"a prerelease", "v1.2.3-rc1"},
		{"build metadata", "v1.2.3+build"},
		{"a leading zero in the major", "v01.2.3"},
		{"a leading zero in the minor", "v1.02.3"},
		{"a leading zero in the patch", "v1.2.03"},
		{"the desktop line", "desktop-v1.0.4"},
		{"a capital V", "V1.2.3"},
		{"a slash", "v1.2.3/evil"},
		{"a path up and out", "../../../evil/v1.2.3"},
		{"dot dot after the tag", "v1.2.3/.."},
		{"an empty number", "v1..3"},
		{"a backslash", `v1.2.3\..\evil`},
		{"a query", "v1.2.3?x=1"},
		{"a fragment", "v1.2.3#x"},
		{"an encoded slash", "v1.2.3%2f"},
		{"a line feed at the end", "v1.2.3\n"},
		{"a line feed before the tag", "x\nv1.2.3"},
		{"a space in front", " v1.2.3"},
		{"a space behind", "v1.2.3 "},
		{"a NUL", "v1.2.3\x00"},
		{"a terminal escape", "v1.2.3\x1b[2J"},
		{"digits outside ASCII", "v\u0661.2.3"},
		{"a minus sign", "v-1.2.3"},
		{"a number too large to compare", "v99999999999999999999.0.0"},
		{"10 KB after a good tag", "v1.2.3" + strings.Repeat("x", 10*1024)},
		{"10 KB of digits", "v" + strings.Repeat("1", 10*1024) + ".0.0"},
	}
}

func everyBadTag() []namedTag { return append(hostileTags(), namedTag{"empty", ""}) }

// short keeps a failure message readable when the value is a 10 KB tag.
func short(s string) string {
	if len(s) > 120 {
		return s[:120] + "..."
	}
	return s
}

// waitFor gives CheckAvailable's goroutine time to finish. The function itself
// stops waiting after a second, which a busy machine can overrun, so what the
// goroutine does is waited for here and never assumed from what the call returned.
func waitFor(t *testing.T, what string, done func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); !done(); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("waited 5 s for %s", what)
		}
	}
}

// standInForGitHub answers every request with the given function until the test
// ends and returns what has been asked so far. Nothing here reaches the network.
// The lock is there because CheckAvailable makes its request on a goroutine of
// its own, which it stops waiting for once its second is up.
func standInForGitHub(t *testing.T, answer func(*http.Request) (*http.Response, error)) (asked func() []string) {
	t.Helper()
	prev := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = prev })
	var mu sync.Mutex
	var urls []string
	http.DefaultTransport = roundTripperFunc(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		urls = append(urls, r.URL.String())
		mu.Unlock()
		return answer(r)
	})
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), urls...)
	}
}

// latestReleaseIs makes GitHub name tag as its latest release.
func latestReleaseIs(t *testing.T, tag string) (asked func() []string) {
	t.Helper()
	body, err := json.Marshal(map[string]string{"tag_name": tag})
	if err != nil {
		t.Fatal(err)
	}
	return standInForGitHub(t, func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(body)), Request: r}, nil
	})
}

// cacheOfOurOwn points the update-check cache at a folder of this test's own, on
// every OS, and returns the path of the cache file. FLOE_NO_UPDATE_CHECK is
// cleared too, so a machine that sets it cannot make these tests pass for nothing.
func cacheOfOurOwn(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, k := range []string{"HOME", "XDG_CONFIG_HOME", "AppData"} {
		t.Setenv(k, dir)
	}
	t.Setenv("FLOE_NO_UPDATE_CHECK", "")
	p := cacheFilePath()
	if p == "" {
		t.Skip("no user config dir on this machine")
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	return p
}

// putInCache writes a fresh cache entry naming tag, as the file could hold after
// an earlier floe saved it or someone edited it.
func putInCache(t *testing.T, p, tag string) {
	t.Helper()
	b, err := json.Marshal(cacheEntry{CheckedAt: time.Now().Add(-time.Minute), Latest: tag})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// TestLatestVersionAcceptsOnlyAPlainReleaseTag: GitHub's answer is refused with
// the fixed line unless it is exactly vX.Y.Z, and the error never carries the
// tag. A release under 9.9.9 used to be offered and installed by every floe (B1).
func TestLatestVersionAcceptsOnlyAPlainReleaseTag(t *testing.T) {
	for _, tag := range goodTags {
		t.Run(tag, func(t *testing.T) {
			latestReleaseIs(t, tag)
			if got, err := LatestVersion(); err != nil || got != tag {
				t.Fatalf("LatestVersion() = %q, %v; want %q", got, err, tag)
			}
		})
	}
	for _, tt := range hostileTags() {
		t.Run(tt.name, func(t *testing.T) {
			latestReleaseIs(t, tt.tag)
			got, err := LatestVersion()
			if got != "" {
				t.Fatalf("LatestVersion() returned the tag %q", short(got))
			}
			if err == nil || err.Error() != unexpectedTagLine {
				t.Fatalf("LatestVersion() error = %v; want the fixed line", err)
			}
		})
	}
}

// TestLatestVersionKeepsItsEmptyCheck: an answer with no tag at all stays the
// failure it has always been, a check that could not complete. It names no
// release, so nothing can reach a URL either.
func TestLatestVersionKeepsItsEmptyCheck(t *testing.T) {
	latestReleaseIs(t, "")
	if got, err := LatestVersion(); got != "" || err == nil || err.Error() != "no tag_name in GitHub API response" {
		t.Fatalf("LatestVersion() = %q, %v", got, err)
	}
}

// TestFromCacheCountsABadTagAsNoCache (B13): the cache is a file anyone on this
// account can edit, and floe 1.11.7 and earlier saved whatever GitHub named, so a
// value in it gets the same check as an answer from GitHub.
func TestFromCacheCountsABadTagAsNoCache(t *testing.T) {
	p := cacheOfOurOwn(t)
	for _, tag := range goodTags {
		putInCache(t, p, tag)
		if got, ok := fromCache(); !ok || got != tag {
			t.Errorf("fromCache() with %q = %q, %v; want a hit", tag, got, ok)
		}
	}
	for _, tt := range everyBadTag() {
		t.Run(tt.name, func(t *testing.T) {
			putInCache(t, p, tt.tag)
			if got, ok := fromCache(); ok || got != "" {
				t.Fatalf("fromCache() = %q, %v; want a miss", short(got), ok)
			}
		})
	}
}

// TestCheckAvailableTreatsABadCachedTagAsNoCache: with a bad value in the cache
// the check asks GitHub, as with no cache, and a good answer replaces the value.
// "" is allowed back because the answer can miss the check's second on a busy
// machine; the bad value itself never comes back.
func TestCheckAvailableTreatsABadCachedTagAsNoCache(t *testing.T) {
	for _, tt := range everyBadTag() {
		t.Run(tt.name, func(t *testing.T) {
			p := cacheOfOurOwn(t)
			putInCache(t, p, tt.tag)
			asked := latestReleaseIs(t, "v1.11.0")
			if got := CheckAvailable("1.10.11"); got != "v1.11.0" && got != "" {
				t.Fatalf("CheckAvailable = %q; want GitHub's answer, v1.11.0", short(got))
			}
			waitFor(t, "GitHub's answer to replace the bad value", func() bool {
				got, ok := fromCache()
				return ok && got == "v1.11.0"
			})
			if n := len(asked()); n != 1 {
				t.Fatalf("GitHub was asked %d time(s), want once", n)
			}
		})
	}
}

// TestCheckAvailableKeepsAGoodCachedTag is the control: a good value is still
// used, and GitHub is not asked.
func TestCheckAvailableKeepsAGoodCachedTag(t *testing.T) {
	p := cacheOfOurOwn(t)
	putInCache(t, p, "v1.11.0")
	asked := latestReleaseIs(t, "v9.9.9")
	if got := CheckAvailable("1.10.11"); got != "v1.11.0" {
		t.Fatalf("CheckAvailable = %q, want the cached v1.11.0", got)
	}
	if got := asked(); len(got) != 0 {
		t.Fatalf("a good cached value still asked GitHub: %q", got)
	}
}

// TestCheckAvailableRefusesABadTagFromGitHub: the hint names no such release, and
// nothing is saved for the next run. Only tags that read as newer than the build,
// the ones that would otherwise be printed. Each costs the check's whole second,
// because a failed request is not reported back to its select.
func TestCheckAvailableRefusesABadTagFromGitHub(t *testing.T) {
	for _, tag := range []string{"9.9.9", "v9.9.9-rc1"} {
		t.Run(tag, func(t *testing.T) {
			p := cacheOfOurOwn(t)
			asked := latestReleaseIs(t, tag)
			if got := CheckAvailable("1.10.11"); got != "" {
				t.Fatalf("CheckAvailable = %q; want no release named", got)
			}
			waitFor(t, "the request to GitHub", func() bool { return len(asked()) == 1 })
			if _, err := os.Stat(p); !os.IsNotExist(err) {
				t.Fatalf("the refused tag left a cache file (stat err %v)", err)
			}
		})
	}
}

// TestWriteCacheStoresOnlyAPlainReleaseTag: nothing fromCache would refuse is ever
// written, whatever a later caller hands it.
func TestWriteCacheStoresOnlyAPlainReleaseTag(t *testing.T) {
	for _, tt := range everyBadTag() {
		t.Run(tt.name, func(t *testing.T) {
			p := cacheOfOurOwn(t)
			writeCache(tt.tag)
			if _, err := os.Stat(p); !os.IsNotExist(err) {
				t.Fatalf("writeCache stored a bad tag (stat err %v)", err)
			}
		})
	}
	p := cacheOfOurOwn(t)
	writeCache("v1.11.0")
	if b, err := os.ReadFile(p); err != nil || !strings.Contains(string(b), `"v1.11.0"`) {
		t.Fatalf("writeCache did not store a good tag: %q, %v", b, err)
	}
}

// TestApplyRefusesABadTagBeforeAnyRequest: the last gate before the tag becomes
// part of two URLs. The stand-in fails every request, so neither this test nor a
// mutation of the guard can get as far as replacing the test binary.
func TestApplyRefusesABadTagBeforeAnyRequest(t *testing.T) {
	asked := standInForGitHub(t, func(*http.Request) (*http.Response, error) {
		return nil, errors.New("no network in this test")
	})
	for _, tt := range everyBadTag() {
		t.Run(tt.name, func(t *testing.T) {
			before := len(asked())
			err := Apply(tt.tag)
			if err == nil || err.Error() != unexpectedTagLine {
				t.Errorf("Apply error = %q; want the fixed line", short(fmt.Sprint(err)))
			}
			if got := asked()[before:]; len(got) != 0 {
				t.Errorf("Apply asked for %d URL(s), the first %q", len(got), short(got[0]))
			}
		})
	}

	// The control: a good tag goes on to ask for that release's checksums, and
	// stops at the stand-in's refusal.
	before := len(asked())
	if err := Apply("v1.2.3"); err == nil || !strings.HasPrefix(err.Error(), "failed to fetch checksums: ") {
		t.Fatalf("Apply(v1.2.3) = %v; want the stand-in's refusal", err)
	}
	want := baseURL + "/v1.2.3/checksums.txt"
	if got := asked()[before:]; len(got) != 1 || got[0] != want {
		t.Fatalf("Apply(v1.2.3) asked for %q, want only %q", got, want)
	}
}
