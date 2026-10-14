package main

// The `floe version` and `floe update` commands. They share a file because
// they are the same concern from the user's side: which build am I on, and
// how do I move.

import (
	"errors"
	"fmt"
	"strings"

	"github.com/jannskiee/floe/cli/internal/selfupdate"
	"github.com/spf13/cobra"
)

// The calls version and update make into selfupdate, as vars so a test can
// stand in for GitHub, for the package-manager check and for the install: a
// test must never fetch a release or replace the test binary.
var (
	checkAvailable = selfupdate.CheckAvailable
	latestVersion  = selfupdate.LatestVersion
	packageManager = selfupdate.PMPath
	applyUpdate    = selfupdate.Apply
)

// shownVersion is a release tag as these two commands print it: without the
// tag's leading v, the form this build's own version has (GoReleaser strips
// it, see main.go), so every line spells a version one way. For printing
// only: the tag itself is what is compared, cached and fetched.
func shownVersion(tag string) string { return strings.TrimPrefix(tag, "v") }

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the floe version",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("floe %s\n", version)
		fmt.Println("Docs: https://www.floe.one/docs")
		// Both ways to update, because floe update refuses on a
		// package-managed install and this line cannot tell every package
		// manager from a script install (selfupdate.DetectPM knows three).
		if latest := checkAvailable(version); latest != "" {
			fmt.Printf("Update available: %s  run `floe update`, or your package manager's upgrade command\n", shownVersion(latest))
		}
	},
}

// ── floe update ───────────────────────────────────────────────────────────────

var flagUpdateCheck bool

var updateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update floe to the latest release",
	Long: `Downloads, verifies, and installs the latest floe release.

If floe was installed via Homebrew, Scoop, or Winget, use your package manager
to update instead (e.g. brew upgrade floe).

Set FLOE_NO_UPDATE_CHECK=1 to suppress the update hint in 'floe version'.`,
	RunE: runUpdate,
}

func init() {
	updateCmd.Flags().BoolVar(&flagUpdateCheck, "check", false, "check for a newer version without installing")
}

// errDevBuild ends floe update on a build that carries no release version (go
// install, a source build), which has nothing to compare a release with. An
// error, so main exits 1 as it does for a package-managed install: the command
// updated nothing, and exit 0 told a script that it had. The sentence is the
// one this branch has always printed.
var errDevBuild = errors.New("Cannot update a dev build.")

func runUpdate(cmd *cobra.Command, args []string) error {
	if version == "dev" {
		return errDevBuild
	}

	if pm := packageManager(); pm != "" {
		hint := selfupdate.PMHint(pm)
		return fmt.Errorf("installed via %s - run `%s` to update", pm, hint)
	}

	fmt.Printf("Current version: %s\n", version)
	fmt.Print("Checking for updates... ")

	latest, err := latestVersion()
	if err != nil {
		return fmt.Errorf("failed to check for updates: %w", err)
	}
	shown := shownVersion(latest)
	fmt.Println(shown)

	if selfupdate.CompareVersions(latest, version) <= 0 {
		fmt.Printf("Already up to date (%s)\n", version)
		return nil
	}

	fmt.Printf("Update available: %s -> %s\n", version, shown)

	if flagUpdateCheck {
		fmt.Printf("Run `floe update` to install.\n")
		return nil
	}

	fmt.Printf("Downloading %s...\n", shown)
	if err := applyUpdate(latest); err != nil {
		return fmt.Errorf("update failed: %w", err)
	}

	fmt.Printf("Updated to %s\n", shown)
	return nil
}
