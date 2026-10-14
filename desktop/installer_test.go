package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The NSIS installer is read, never run, here: building it needs makensis and
// running it changes the machine. What these tests hold is the script's shape.

const (
	nsiPath   = "build/windows/installer/project.nsi"
	toolsPath = "build/windows/installer/wails_tools.nsh"
)

// nsisLines returns a script's lines with comments and blank lines removed.
// NSIS comments start with # or ; at the start of a statement.
func nsisLines(t *testing.T, path string) []string {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, l := range strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "#") || strings.HasPrefix(l, ";") {
			continue
		}
		out = append(out, l)
	}
	return out
}

// nsisBlock returns the lines after the line that is exactly open, up to the
// first line that is exactly end.
func nsisBlock(t *testing.T, lines []string, open, end string) []string {
	t.Helper()
	for i, l := range lines {
		if l != open {
			continue
		}
		for j := i + 1; j < len(lines); j++ {
			if lines[j] == end {
				return lines[i+1 : j]
			}
		}
		t.Fatalf("%q has no %q after it", open, end)
	}
	t.Fatalf("no line is %q", open)
	return nil
}

var (
	// File "/oname=${PRODUCT_EXECUTABLE}" "${ARG_WAILS_AMD64_BINARY}"
	nsisFileOname = regexp.MustCompile(`^File\s+"/oname=([^"]+)"`)
	// WriteUninstaller "$INSTDIR\uninstall.exe"
	nsisUninstaller = regexp.MustCompile(`^WriteUninstaller\s+"\$INSTDIR\\([^"]+)"`)
	// Delete "$INSTDIR\name"
	nsisDeleteInst = regexp.MustCompile(`^Delete\s+"\$INSTDIR\\([^"]+)"`)
	// RMDir /r, in any letter case
	nsisRMDirR = regexp.MustCompile(`(?i)^RMDir\s+/r\b`)
)

// TestUninstallerRemovesOnlyWhatItInstalled (A3-B2): the install folder is
// whatever the person typed on the directory page, and NSIS appends the
// product folder name only to a folder picked with Browse, never to one typed
// into the box. So $INSTDIR can be Desktop or Documents itself, and the
// uninstaller's RMDir /r $INSTDIR deleted everything in it. It now deletes the
// files the installer wrote, by name, and removes the folder only when that
// leaves it empty.
func TestUninstallerRemovesOnlyWhatItInstalled(t *testing.T) {
	nsi := nsisLines(t, nsiPath)
	install := nsisBlock(t, nsi, "Section", "SectionEnd")
	uninstall := nsisBlock(t, nsi, `Section "uninstall"`, "SectionEnd")

	// What the installer writes into $INSTDIR: the files of wails.files (the
	// generated macro), any File line of the install section, and the
	// uninstaller itself.
	// One name per file: wails.files writes the same name once per processor.
	installed := map[string]bool{}
	collect := func(lines []string) {
		for _, l := range lines {
			if m := nsisFileOname.FindStringSubmatch(l); m != nil {
				installed[m[1]] = true
			}
			if strings.HasPrefix(l, "File ") && !nsisFileOname.MatchString(l) {
				t.Errorf("a File line without /oname cannot be matched to its uninstall Delete: %q", l)
			}
			if m := nsisUninstaller.FindStringSubmatch(l); m != nil {
				installed[m[1]] = true
			}
		}
	}
	collect(nsisBlock(t, nsisLines(t, toolsPath), "!macro wails.files", "!macroend"))
	collect(install)
	if len(installed) < 2 {
		t.Fatalf("found %v installed into $INSTDIR, want the app and uninstall.exe at least", installed)
	}

	deleted := map[string]int{}
	lastDelete, rmdir := -1, -1
	for i, l := range uninstall {
		if nsisRMDirR.MatchString(l) {
			t.Errorf("the uninstaller removes a folder recursively: %q", l)
		}
		if m := nsisDeleteInst.FindStringSubmatch(l); m != nil {
			deleted[m[1]] = i
			lastDelete = i
		}
		if l == "RMDir $INSTDIR" || l == `RMDir "$INSTDIR"` {
			rmdir = i
		}
	}
	for name := range installed {
		if _, ok := deleted[name]; !ok {
			t.Errorf("the installer writes $INSTDIR\\%s and the uninstaller never deletes it", name)
		}
	}
	if rmdir < 0 {
		t.Fatal(`the uninstaller never removes the emptied install folder (want a plain "RMDir $INSTDIR")`)
	}
	if rmdir < lastDelete {
		t.Errorf("RMDir $INSTDIR runs before the last Delete, so the folder is never empty when it runs")
	}
}
