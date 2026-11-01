package main

// floe version and floe update (update.go) through the real command tree,
// with GitHub, the package-manager check and the install stood in: nothing
// here fetches a release or replaces the test binary.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/internal/selfupdate"
)

// updateStubs is what one test's stand-ins saw: the tags handed to the
// install, and how many times GitHub would have been asked.
type updateStubs struct {
	applied []string
	lookups int
}

// stubUpdate makes this build read as version build, GitHub name latest as
// its newest release (the tag as the API returns it, leading v and all) and
// pm own the binary ("" for none), until the test ends.
func stubUpdate(t *testing.T, build, latest, pm string) *updateStubs {
	t.Helper()
	s := &updateStubs{}
	prevVersion := version
	prevCheck, prevLatest, prevPM, prevApply := checkAvailable, latestVersion, packageManager, applyUpdate
	t.Cleanup(func() {
		version = prevVersion
		checkAvailable, latestVersion, packageManager, applyUpdate = prevCheck, prevLatest, prevPM, prevApply
	})
	version = build
	checkAvailable = func(string) string {
		s.lookups++
		return latest
	}
	latestVersion = func() (string, error) {
		s.lookups++
		return latest, nil
	}
	packageManager = func() string { return pm }
	applyUpdate = func(tag string) error {
		s.applied = append(s.applied, tag)
		return nil
	}
	return s
}

// runUpdateCLI runs `floe args...` through execute, as main runs it, and
// returns stdout (where both commands print), what execute printed to the
// error writer, and the error main turns into exit 1. Cobra keeps --check on
// the tree between Execute calls, so it goes back to its default afterwards.
func runUpdateCLI(t *testing.T, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	resetSharedFlags(t)
	check := updateCmd.Flags().Lookup("check")
	t.Cleanup(func() {
		_ = check.Value.Set(check.DefValue)
		check.Changed = false
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetArgs(nil)
	})
	var out, errOut strings.Builder
	rootCmd.SetOut(&out)
	rootCmd.SetErr(&errOut)
	stdout = captureStdout(t, func() { err = execute(args) })
	return stdout + out.String(), errOut.String(), err
}

// TestVersionNoticeNamesBothWaysToUpdate: the notice floe version prints when
// a newer release exists names floe update and the package manager, because
// floe update refuses on a package-managed install, and it spells the release
// as the line above it spells this build, without the tag's leading v.
func TestVersionNoticeNamesBothWaysToUpdate(t *testing.T) {
	stubUpdate(t, "1.10.11", "v1.11.0", "")
	stdout, stderr, err := runUpdateCLI(t, "version")
	want := "floe 1.10.11\n" +
		"Docs: https://www.floe.one/docs\n" +
		"Update available: 1.11.0  run `floe update`, or your package manager's upgrade command\n"
	if err != nil || stderr != "" || stdout != want {
		t.Fatalf("floe version printed\n%q\nwant\n%q\n(stderr %q, error %v)", stdout, want, stderr, err)
	}
}

// TestVersionPrintsNoNoticeWhenNothingIsNewer: the two lines alone.
func TestVersionPrintsNoNoticeWhenNothingIsNewer(t *testing.T) {
	stubUpdate(t, "1.11.0", "", "")
	stdout, stderr, err := runUpdateCLI(t, "version")
	if want := "floe 1.11.0\nDocs: https://www.floe.one/docs\n"; err != nil || stderr != "" || stdout != want {
		t.Fatalf("floe version printed %q, want %q (stderr %q, error %v)", stdout, want, stderr, err)
	}
}

// TestUpdatePrintsEveryVersionOneWay: every line floe update prints names a
// version without a leading v, the form this build's own version has, while
// the install is still handed the tag as GitHub names it.
func TestUpdatePrintsEveryVersionOneWay(t *testing.T) {
	cases := []struct {
		name    string
		latest  string
		args    []string
		want    string
		applied []string
	}{
		{
			name:   "a newer release is installed",
			latest: "v1.11.0",
			args:   []string{"update"},
			want: "Current version: 1.10.11\n" +
				"Checking for updates... 1.11.0\n" +
				"Update available: 1.10.11 -> 1.11.0\n" +
				"Downloading 1.11.0...\n" +
				"Updated to 1.11.0\n",
			applied: []string{"v1.11.0"},
		},
		{
			name:   "--check installs nothing",
			latest: "v1.11.0",
			args:   []string{"update", "--check"},
			want: "Current version: 1.10.11\n" +
				"Checking for updates... 1.11.0\n" +
				"Update available: 1.10.11 -> 1.11.0\n" +
				"Run `floe update` to install.\n",
		},
		{
			name:   "nothing newer",
			latest: "v1.10.11",
			args:   []string{"update"},
			want: "Current version: 1.10.11\n" +
				"Checking for updates... 1.10.11\n" +
				"Already up to date (1.10.11)\n",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := stubUpdate(t, "1.10.11", c.latest, "")
			stdout, stderr, err := runUpdateCLI(t, c.args...)
			if err != nil || stderr != "" || stdout != c.want {
				t.Fatalf("floe %s printed\n%q\nwant\n%q\n(stderr %q, error %v)", strings.Join(c.args, " "), stdout, c.want, stderr, err)
			}
			if strings.Join(s.applied, ",") != strings.Join(c.applied, ",") {
				t.Fatalf("the install was handed %q, want %q", s.applied, c.applied)
			}
		})
	}
}

// TestUpdateOnADevBuildIsAnError: a build with no release version cannot be
// updated, and floe update says so as an error, so main exits 1 and a script
// can tell it from an update that ran. It asks GitHub nothing first.
func TestUpdateOnADevBuildIsAnError(t *testing.T) {
	for _, args := range [][]string{{"update"}, {"update", "--check"}} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			s := stubUpdate(t, "dev", "v1.11.0", "")
			stdout, stderr, err := runUpdateCLI(t, args...)
			if err == nil {
				t.Fatal("floe update on a dev build returned no error: main would exit 0 with nothing updated")
			}
			if want := "Error: Cannot update a dev build.\n"; stderr != want || stdout != "" {
				t.Fatalf("stderr %q, stdout %q; want %q and nothing", stderr, stdout, want)
			}
			if s.lookups != 0 || len(s.applied) != 0 {
				t.Fatalf("a dev build asked GitHub %d time(s) and installed %q", s.lookups, s.applied)
			}
		})
	}
}

// TestUpdateOnAPackageManagedInstallNamesItsCommand: the refusal a
// package-managed install has always had, before any request to GitHub.
func TestUpdateOnAPackageManagedInstallNamesItsCommand(t *testing.T) {
	s := stubUpdate(t, "1.10.11", "v1.11.0", "homebrew")
	stdout, stderr, err := runUpdateCLI(t, "update")
	if err == nil {
		t.Fatal("floe update on a Homebrew install returned no error")
	}
	if want := "Error: installed via homebrew - run `brew upgrade floe` to update\n"; stderr != want || stdout != "" {
		t.Fatalf("stderr %q, stdout %q; want %q and nothing", stderr, stdout, want)
	}
	if s.lookups != 0 || len(s.applied) != 0 {
		t.Fatalf("a package-managed install asked GitHub %d time(s) and installed %q", s.lookups, s.applied)
	}
}

// The line floe update stops with on a release that is not vX.Y.Z (B1), and
// what stdout holds by then: the check's line, ended, so the sentence stands on
// a line of its own. Compared whole, so no test below has to look for the tag.
const (
	unexpectedTagStderr = "Error: The latest release has an unexpected version name, so floe update stopped. Reinstall with the steps at floe.one/docs/cli/installation instead.\n"
	unexpectedTagStdout = "Current version: 1.10.11\nChecking for updates... \n"
)

// badTags are release names floe update must stop on, without printing them.
// The empty one is in badTagsFromTheSeam alone: an empty answer from GitHub has
// its own line, TestUpdateOnAnEmptyAnswerKeepsItsLine.
var badTags = []string{
	"9.9.9",
	"v1.2",
	"v1.2.3-rc1",
	"v01.2.3",
	"desktop-v1.0.4",
	"v1.2.3/evil",
	"../../../evil/v1.2.3",
	"v1..3",
	"v1.2.3\n",
	"v1.2.3" + strings.Repeat("x", 10*1024),
	"v" + strings.Repeat("1", 10*1024) + ".0.0",
}

func badTagsFromTheSeam() []string { return append(append([]string(nil), badTags...), "") }

// short keeps a failure message readable when the value is a 10 KB tag.
func short(s string) string {
	if len(s) > 200 {
		return s[:200] + "..."
	}
	return s
}

// checkStoppedOnBadTag holds one run to the fixed output and no install.
func checkStoppedOnBadTag(t *testing.T, s *updateStubs, stdout, stderr string, err error) {
	t.Helper()
	if err == nil {
		t.Error("floe update returned no error: main would exit 0 with nothing updated")
	}
	if stderr != unexpectedTagStderr {
		t.Errorf("stderr %q\nwant    %q", short(stderr), unexpectedTagStderr)
	}
	if stdout != unexpectedTagStdout {
		t.Errorf("stdout %q\nwant    %q", short(stdout), unexpectedTagStdout)
	}
	if len(s.applied) != 0 {
		t.Errorf("the install was handed %d tag(s), the first %q", len(s.applied), short(s.applied[0]))
	}
}

// answerFromGitHub stands in for GitHub until the test ends, naming tag as the
// latest release, so the real selfupdate calls can run with no network. It returns
// how many requests have come in.
func answerFromGitHub(t *testing.T, tag string) (asked func() int32) {
	t.Helper()
	body, err := json.Marshal(map[string]string{"tag_name": tag})
	if err != nil {
		t.Fatal(err)
	}
	prev := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = prev })
	var requests atomic.Int32
	http.DefaultTransport = updateRoundTripper(func(r *http.Request) (*http.Response, error) {
		requests.Add(1)
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(body)), Request: r}, nil
	})
	return requests.Load
}

type updateRoundTripper func(*http.Request) (*http.Response, error)

func (f updateRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// waitUntilAsked waits for the request CheckAvailable makes on a goroutine of its
// own, which it stops waiting for after a second. A busy machine can overrun that,
// and the stand-in must not be taken away from under the goroutine.
func waitUntilAsked(t *testing.T, asked func() int32) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); asked() == 0; time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("waited 5 s, and GitHub was never asked")
		}
	}
}

// TestUpdateStopsOnABadTag: a tag that is not vX.Y.Z stops floe update before
// any line prints it, with or without --check, however it got past selfupdate.
func TestUpdateStopsOnABadTag(t *testing.T) {
	for _, args := range [][]string{{"update"}, {"update", "--check"}} {
		for i, tag := range badTagsFromTheSeam() {
			t.Run(fmt.Sprintf("%s/%d", strings.Join(args, " "), i), func(t *testing.T) {
				s := stubUpdate(t, "1.10.11", tag, "")
				stdout, stderr, err := runUpdateCLI(t, args...)
				checkStoppedOnBadTag(t, s, stdout, stderr, err)
			})
		}
	}
}

// TestUpdateStopsOnABadTagFromGitHub: the same through the real LatestVersion,
// whose refusal must reach the user as the fixed line itself, not wrapped as a
// check that failed.
func TestUpdateStopsOnABadTagFromGitHub(t *testing.T) {
	for i, tag := range badTags {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			s := stubUpdate(t, "1.10.11", "", "")
			latestVersion = selfupdate.LatestVersion
			answerFromGitHub(t, tag)
			stdout, stderr, err := runUpdateCLI(t, "update")
			checkStoppedOnBadTag(t, s, stdout, stderr, err)
		})
	}
}

// TestUpdateOnAnEmptyAnswerKeepsItsLine: an answer that names no release stays a
// check that could not complete, and every other failure of the check keeps its
// wrapper. Nothing is installed either way.
func TestUpdateOnAnEmptyAnswerKeepsItsLine(t *testing.T) {
	s := stubUpdate(t, "1.10.11", "", "")
	latestVersion = selfupdate.LatestVersion
	answerFromGitHub(t, "")
	stdout, stderr, err := runUpdateCLI(t, "update")
	if err == nil {
		t.Fatal("floe update returned no error on an answer with no tag")
	}
	if want := "Error: failed to check for updates: no tag_name in GitHub API response\n"; stderr != want {
		t.Fatalf("stderr %q, want %q", stderr, want)
	}
	if want := "Current version: 1.10.11\nChecking for updates... "; stdout != want {
		t.Fatalf("stdout %q, want %q", stdout, want)
	}
	if len(s.applied) != 0 {
		t.Fatalf("the install was handed %q", s.applied)
	}
}

// updateCacheHolds gives this test an update-check cache of its own holding tag,
// through the real file the real selfupdate.CheckAvailable reads. A tag of ""
// means no file at all.
func updateCacheHolds(t *testing.T, tag string) {
	t.Helper()
	dir := t.TempDir()
	for _, k := range []string{"HOME", "XDG_CONFIG_HOME", "AppData"} {
		t.Setenv(k, dir)
	}
	t.Setenv("FLOE_NO_UPDATE_CHECK", "")
	if tag == "" {
		return
	}
	configDir, err := os.UserConfigDir()
	if err != nil {
		t.Skipf("no user config dir on this machine: %v", err)
	}
	p := filepath.Join(configDir, "floe", "update-check.json")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(map[string]any{"checked_at": time.Now().Add(-time.Minute), "latest": tag})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestVersionNoticeIgnoresABadCachedTag (B13): floe version reads a cache that an
// earlier floe wrote. A bad value there is never printed: it counts as no cache, so
// GitHub is asked and the notice names its answer. The notice may be missing when
// a busy machine overruns the check's second; the bad value may never appear.
func TestVersionNoticeIgnoresABadCachedTag(t *testing.T) {
	for i, tag := range badTags {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			stubUpdate(t, "1.10.11", "", "")
			checkAvailable = selfupdate.CheckAvailable
			updateCacheHolds(t, tag)
			asked := answerFromGitHub(t, "v1.11.0")
			stdout, stderr, err := runUpdateCLI(t, "version")
			noNotice := "floe 1.10.11\nDocs: https://www.floe.one/docs\n"
			want := noNotice + "Update available: 1.11.0  run `floe update`, or your package manager's upgrade command\n"
			if err != nil || stderr != "" || (stdout != want && stdout != noNotice) {
				t.Fatalf("floe version printed\n%q\nwant\n%q\n(stderr %q, error %v)", short(stdout), want, stderr, err)
			}
			waitUntilAsked(t, asked)
		})
	}
}

// TestVersionPrintsNoNoticeForABadTagFromGitHub: and with no cache, a release
// GitHub names under a bad tag gets no notice. Each case costs the check's whole
// second, so only the two that read as newer than the build, the ones that would
// otherwise print.
func TestVersionPrintsNoNoticeForABadTagFromGitHub(t *testing.T) {
	for _, tag := range []string{"9.9.9", "v9.9.9-rc1"} {
		t.Run(tag, func(t *testing.T) {
			stubUpdate(t, "1.10.11", "", "")
			checkAvailable = selfupdate.CheckAvailable
			updateCacheHolds(t, "")
			asked := answerFromGitHub(t, tag)
			stdout, stderr, err := runUpdateCLI(t, "version")
			if want := "floe 1.10.11\nDocs: https://www.floe.one/docs\n"; err != nil || stderr != "" || stdout != want {
				t.Fatalf("floe version printed %q, want %q (stderr %q, error %v)", stdout, want, stderr, err)
			}
			waitUntilAsked(t, asked)
		})
	}
}
