package main

// The `floe version` and `floe update` commands. They share a file because
// they are the same concern from the user's side: which build am I on, and
// how do I move.

import (
	"fmt"
	"os"

	"github.com/jannskiee/floe/cli/internal/selfupdate"
	"github.com/spf13/cobra"
)

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the floe version",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("floe %s\n", version)
		fmt.Println("Docs: https://www.floe.one/docs")
		if latest := selfupdate.CheckAvailable(version); latest != "" {
			fmt.Printf("Update available: %s  run `floe update` to upgrade\n", latest)
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

func runUpdate(cmd *cobra.Command, args []string) error {
	if version == "dev" {
		fmt.Fprintln(os.Stderr, "Cannot update a dev build.")
		return nil
	}

	if pm := selfupdate.PMPath(); pm != "" {
		hint := selfupdate.PMHint(pm)
		return fmt.Errorf("installed via %s - run `%s` to update", pm, hint)
	}

	fmt.Printf("Current version: %s\n", version)
	fmt.Print("Checking for updates... ")

	latest, err := selfupdate.LatestVersion()
	if err != nil {
		return fmt.Errorf("failed to check for updates: %w", err)
	}
	fmt.Println(latest)

	if selfupdate.CompareVersions(latest, version) <= 0 {
		fmt.Printf("Already up to date (%s)\n", version)
		return nil
	}

	fmt.Printf("Update available: %s -> %s\n", version, latest)

	if flagUpdateCheck {
		fmt.Printf("Run `floe update` to install.\n")
		return nil
	}

	fmt.Printf("Downloading %s...\n", latest)
	if err := selfupdate.Apply(latest); err != nil {
		return fmt.Errorf("update failed: %w", err)
	}

	fmt.Printf("Updated to %s\n", latest)
	return nil
}
