package main

// floe version and floe update (update.go) through the real command tree,
// with GitHub, the package-manager check and the install stood in: nothing
// here fetches a release or replaces the test binary.

import (
	"strings"
	"testing"
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
