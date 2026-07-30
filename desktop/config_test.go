package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestConfigRoundTrip proves a saved address comes back verbatim, which is the
// whole point of keeping this outside localStorage: the setting has to survive a
// relaunch and an exe rename.
func TestConfigRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "floe", "desktop.json")

	want := appConfig{Server: "https://floe.example.com", Web: "https://app.example.com"}
	if err := saveConfigTo(path, want); err != nil {
		t.Fatalf("saveConfigTo: %v", err)
	}
	if got := loadConfigFrom(path); got != want {
		t.Errorf("loadConfigFrom = %+v, want %+v", got, want)
	}
}

// TestConfigNormalizesOnSaveAndLoad guards the trailing slash at both ends. Every
// consumer appends a path to these values, so one stray slash produces "//api/..."
// which 404s, and ice.Fetch turns that 404 into a silent fallback to public STUN.
func TestConfigNormalizesOnSaveAndLoad(t *testing.T) {
	dir := t.TempDir()

	saved := filepath.Join(dir, "saved.json")
	if err := saveConfigTo(saved, appConfig{Server: " https://floe.example.com// ", Web: "https://app.example.com/"}); err != nil {
		t.Fatalf("saveConfigTo: %v", err)
	}
	got := loadConfigFrom(saved)
	if got.Server != "https://floe.example.com" || got.Web != "https://app.example.com" {
		t.Errorf("after save, config = %+v, want both origins trimmed", got)
	}

	// A file hand-edited outside the app must be normalized on the way in too.
	handEdited := filepath.Join(dir, "hand.json")
	if err := os.WriteFile(handEdited, []byte(`{"server":"https://floe.example.com/","web":""}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := loadConfigFrom(handEdited); got.Server != "https://floe.example.com" {
		t.Errorf("hand-edited server = %q, want it trimmed", got.Server)
	}
}

// TestLoadConfigFallsBackToDefaults covers every way the file can be unusable.
// None of them is worth an error dialog: the app just runs against Floe's servers.
func TestLoadConfigFallsBackToDefaults(t *testing.T) {
	dir := t.TempDir()

	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}

	for _, tc := range []struct{ name, path string }{
		{"missing file", filepath.Join(dir, "absent.json")},
		{"empty file", write("empty.json", "")},
		{"malformed json", write("bad.json", "{not json")},
		{"wrong shape", write("shape.json", `["a","b"]`)},
		{"no config dir", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := loadConfigFrom(tc.path); got != (appConfig{}) {
				t.Errorf("loadConfigFrom = %+v, want the zero value", got)
			}
		})
	}
}

// TestSaveConfigIsAtomic asserts the temp file is gone afterwards, so a crash
// between write and rename can never leave a half-written settings file behind.
func TestSaveConfigIsAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "desktop.json")

	if err := saveConfigTo(path, appConfig{Server: "https://floe.example.com"}); err != nil {
		t.Fatalf("saveConfigTo: %v", err)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("temp file still present after save (err = %v)", err)
	}

	// Overwriting an existing file must also land cleanly.
	if err := saveConfigTo(path, appConfig{Server: "https://other.example.com"}); err != nil {
		t.Fatalf("second saveConfigTo: %v", err)
	}
	if got := loadConfigFrom(path); got.Server != "https://other.example.com" {
		t.Errorf("server = %q, want the overwritten value", got.Server)
	}
}

// TestSaveConfigWithoutPath is the counterpart to the "no config dir" load case:
// it must report a real error rather than writing into the process's cwd.
func TestSaveConfigWithoutPath(t *testing.T) {
	if err := saveConfigTo("", appConfig{Server: "https://floe.example.com"}); err == nil {
		t.Error("saveConfigTo(\"\") = nil, want an error")
	}
}

// TestNormalizeConfigPreservesToggles guards a trap that the address-only version
// of this struct hid: normalizeConfig used to build a fresh appConfig from just
// Server and Web, so widening the struct would have silently dropped every new
// field on both save and load. Nothing else would have failed, and the symptom
// would have been preferences that reset themselves.
func TestNormalizeConfigPreservesToggles(t *testing.T) {
	in := appConfig{
		Server:      " https://floe.example.com/ ",
		Web:         "https://app.example.com/",
		HideIP:      true,
		ReportStats: false,
		Migrated:    true,
	}
	got := normalizeConfig(in)

	if got.Server != "https://floe.example.com" || got.Web != "https://app.example.com" {
		t.Errorf("addresses not normalized: %+v", got)
	}
	if !got.HideIP || got.ReportStats || !got.Migrated {
		t.Errorf("normalizeConfig dropped non-address fields: %+v", got)
	}
}

// TestTogglesRoundTrip is the reason these settings moved out of localStorage at
// all: they have to survive a relaunch under a different executable name.
func TestTogglesRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "floe", "desktop.json")

	// ReportStats false is the interesting case. It is the non-zero-value choice,
	// so it is the one a bug would silently discard.
	want := appConfig{HideIP: true, ReportStats: false, Migrated: true}
	if err := saveConfigTo(path, want); err != nil {
		t.Fatalf("saveConfigTo: %v", err)
	}
	if got := loadConfigFrom(path); got != want {
		t.Errorf("loadConfigFrom = %+v, want %+v", got, want)
	}
}

// TestUnmigratedConfigIsDetectable is what stops the one-time localStorage import
// from being skipped or repeated. A fresh install, an unreadable file, and a file
// written before the toggles moved here must all report Migrated false, because
// ReportStats defaults to TRUE and the Go zero value is false: treating an
// unmigrated record as authoritative would opt people out of the stats counter
// they had already agreed to.
func TestUnmigratedConfigIsDetectable(t *testing.T) {
	dir := t.TempDir()

	// A file from before the toggles existed.
	old := filepath.Join(dir, "old.json")
	if err := os.WriteFile(old, []byte(`{"server":"https://floe.example.com","web":""}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := loadConfigFrom(old); got.Migrated {
		t.Error("a pre-toggle config reported Migrated true, so the import would be skipped")
	}

	// A fresh install: no file at all.
	if got := loadConfigFrom(filepath.Join(dir, "absent.json")); got.Migrated {
		t.Error("a missing config reported Migrated true")
	}

	// Once written through the real path it must stay migrated.
	saved := filepath.Join(dir, "saved.json")
	if err := saveConfigTo(saved, appConfig{ReportStats: true, Migrated: true}); err != nil {
		t.Fatal(err)
	}
	if got := loadConfigFrom(saved); !got.Migrated {
		t.Error("a saved config lost its Migrated flag, so the import would run again")
	}
}
