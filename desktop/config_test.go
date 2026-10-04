package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
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
		Server:        " https://floe.example.com/ ",
		Web:           "https://app.example.com/",
		HideIP:        true,
		ReportStats:   false,
		NoUpdateCheck: true,
		Migrated:      true,
	}
	got := normalizeConfig(in)

	if got.Server != "https://floe.example.com" || got.Web != "https://app.example.com" {
		t.Errorf("addresses not normalized: %+v", got)
	}
	if !got.HideIP || got.ReportStats || !got.NoUpdateCheck || !got.Migrated {
		t.Errorf("normalizeConfig dropped non-address fields: %+v", got)
	}
}

// TestUpdateCheckFieldRoundTrip pins the opted-out state: NoUpdateCheck true is
// the non-default choice, so it is the one a widening bug would silently drop.
func TestUpdateCheckFieldRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "floe", "desktop.json")

	want := appConfig{ReportStats: true, NoUpdateCheck: true, Migrated: true}
	if err := saveConfigTo(path, want); err != nil {
		t.Fatalf("saveConfigTo: %v", err)
	}
	if got := loadConfigFrom(path); got != want {
		t.Errorf("loadConfigFrom = %+v, want %+v", got, want)
	}
}

// TestAbsentUpdateCheckFieldDefaultsOn is the reason the field is inverted: a
// desktop.json written before the field existed (every current install, all of
// them migrated:true so no import will run) must come back with checking ON.
func TestAbsentUpdateCheckFieldDefaultsOn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pre-feature.json")
	body := `{"server":"","web":"","hideIP":false,"reportStats":true,"migrated":true}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	got := loadConfigFrom(path)
	if got.NoUpdateCheck {
		t.Error("a pre-feature config loaded with NoUpdateCheck true; existing installs would silently stop checking")
	}
	if !got.Migrated || !got.ReportStats {
		t.Errorf("pre-feature fields damaged: %+v", got)
	}
}

// TestSettingsFromArgsPreservesUpdateCheck pins the SetSettings-clobber trap:
// the Settings screen saves through settingsFromArgs, which knows nothing about
// the update toggle, so the current record's value must carry over verbatim.
func TestSettingsFromArgsPreservesUpdateCheck(t *testing.T) {
	cur := appConfig{NoUpdateCheck: true, Migrated: true}
	got := settingsFromArgs(cur, "https://floe.example.com/", "", true, false)

	if !got.NoUpdateCheck {
		t.Error("settingsFromArgs dropped NoUpdateCheck; every settings save would re-enable the check")
	}
	if !got.Migrated {
		t.Error("settingsFromArgs must always mark the record migrated")
	}
	if got.Server != "https://floe.example.com" || !got.HideIP || got.ReportStats {
		t.Errorf("argument fields wrong: %+v", got)
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

// TestResetWritesDefaults simulates what "Reset all settings" puts on disk.
//
// The frontend calls SetSettings("", "", false, true), which normalizes and
// writes exactly this record. The invariant worth pinning is Migrated: if a reset
// ever wrote it false, the next launch would re-run the one-time localStorage
// import and resurrect the very values the user just cleared.
func TestResetWritesDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "floe", "desktop.json")

	// A thoroughly customised install: both addresses set, both toggles flipped
	// away from their defaults.
	custom := appConfig{
		Server:      "https://files.example.com",
		Web:         "https://app.example.com",
		HideIP:      true,
		ReportStats: false,
		Migrated:    true,
	}
	if err := saveConfigTo(path, custom); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Exactly what SetSettings("", "", false, true) constructs.
	reset := normalizeConfig(appConfig{Server: "", Web: "", HideIP: false, ReportStats: true, Migrated: true})
	if err := saveConfigTo(path, reset); err != nil {
		t.Fatalf("reset: %v", err)
	}

	got := loadConfigFrom(path)
	want := appConfig{Server: "", Web: "", HideIP: false, ReportStats: true, Migrated: true}
	if got != want {
		t.Errorf("after reset config = %+v, want %+v", got, want)
	}
	if !got.Migrated {
		t.Error("reset cleared Migrated, so the next launch would re-import the old values from localStorage")
	}
	if got.ReportStats != true {
		t.Error("reset left stats opted out; true is the shipped default and the Go zero value is the wrong answer here")
	}
}

func TestWebviewDataPathIsStable(t *testing.T) {
	p := webviewDataPath()
	if p == "" {
		t.Skip("no user config dir on this system")
	}
	if filepath.Base(p) != "webview" || filepath.Base(filepath.Dir(p)) != "floe" {
		t.Errorf("webviewDataPath() = %q, want .../floe/webview", p)
	}
	if p != webviewDataPath() {
		t.Error("webviewDataPath is not deterministic")
	}
}

func TestMigrateWebviewProfileAdoptsOldDir(t *testing.T) {
	root := t.TempDir()
	old := filepath.Join(root, "floe-desktop.exe")
	if err := os.MkdirAll(filepath.Join(old, "EBWebView"), 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(old, "EBWebView", "marker.txt")
	if err := os.WriteFile(marker, []byte("history"), 0o644); err != nil {
		t.Fatal(err)
	}

	newPath := filepath.Join(root, "floe", "webview")
	migrateWebviewProfile(newPath, filepath.Join(root, "missing"), old)

	got, err := os.ReadFile(filepath.Join(newPath, "EBWebView", "marker.txt"))
	if err != nil {
		t.Fatalf("profile was not adopted: %v", err)
	}
	if string(got) != "history" {
		t.Errorf("marker = %q, want %q", got, "history")
	}
	if _, err := os.Stat(old); !errors.Is(err, os.ErrNotExist) {
		t.Error("old profile dir should have been renamed away")
	}
}

func TestMigrateWebviewProfileNeverOverwrites(t *testing.T) {
	root := t.TempDir()
	newPath := filepath.Join(root, "webview")
	if err := os.MkdirAll(newPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(newPath, "keep.txt"), []byte("pinned"), 0o644); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(root, "desktop.exe")
	if err := os.MkdirAll(old, 0o755); err != nil {
		t.Fatal(err)
	}

	migrateWebviewProfile(newPath, old)

	if _, err := os.Stat(old); err != nil {
		t.Error("existing pinned profile must win; the old dir should be untouched")
	}
	if _, err := os.Stat(filepath.Join(newPath, "keep.txt")); err != nil {
		t.Error("pinned profile contents were disturbed")
	}
}

func TestMigrateWebviewProfileHandlesNothingToDo(t *testing.T) {
	root := t.TempDir()
	// No old dirs at all: must not create the new path or panic.
	newPath := filepath.Join(root, "webview")
	migrateWebviewProfile(newPath, filepath.Join(root, "a"), "", filepath.Join(root, "b"))
	if _, err := os.Stat(newPath); !errors.Is(err, os.ErrNotExist) {
		t.Error("nothing to migrate should create nothing")
	}
	migrateWebviewProfile("", filepath.Join(root, "a")) // "" target is a no-op
}

func TestMigrateWebviewProfileAdoptsOverEmptyHusk(t *testing.T) {
	root := t.TempDir()
	newPath := filepath.Join(root, "floe", "webview")
	// A fileless husk exactly like the 2026-06-28 scaffold left behind:
	// nested directories, zero files.
	if err := os.MkdirAll(filepath.Join(newPath, "EBWebView", "Default"), 0o755); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(root, "floe-desktop.exe")
	if err := os.MkdirAll(old, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(old, "data.txt"), []byte("real"), 0o644); err != nil {
		t.Fatal(err)
	}

	migrateWebviewProfile(newPath, old)

	if got, err := os.ReadFile(filepath.Join(newPath, "data.txt")); err != nil || string(got) != "real" {
		t.Errorf("empty husk must not block adoption: %v %q", err, got)
	}
}

// TestLoadConfigIgnoresLegacyRequestLinksKey (H7 S-2): a desktop.json written
// while the Beta switch existed still carries "requestLinks", on or off. It
// must load with every other field intact, and the next save must not write
// the key back, so the file sheds it the first time anything changes.
func TestLoadConfigIgnoresLegacyRequestLinksKey(t *testing.T) {
	for _, legacy := range []string{"true", "false"} {
		t.Run("requestLinks "+legacy, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "legacy.json")
			body := `{"server":"https://x.test","hideIP":true,"requestLinks":` + legacy + `,"migrated":true}`
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}

			got := loadConfigFrom(path)
			if got.Server != "https://x.test" || !got.HideIP || !got.Migrated {
				t.Fatalf("legacy file damaged on load: %+v", got)
			}

			out := filepath.Join(dir, "resaved.json")
			if err := saveConfigTo(out, got); err != nil {
				t.Fatalf("saveConfigTo: %v", err)
			}
			raw, err := os.ReadFile(out)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(raw), "requestLinks") {
				t.Errorf("a re-save wrote the retired requestLinks key back:\n%s", raw)
			}
			if again := loadConfigFrom(out); again != got {
				t.Errorf("re-saved record = %+v, want %+v", again, got)
			}
		})
	}
}

// TestToastPrefsDefaultOnWhenAbsent is the reason both toast fields are
// inverted (H7 S-11): a desktop.json from before them must keep every toast,
// with its sound, so the zero value is today's behavior.
func TestToastPrefsDefaultOnWhenAbsent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pre-toasts.json")
	body := `{"server":"","web":"","hideIP":false,"reportStats":true,"noUpdateCheck":true,"migrated":true}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	got := loadConfigFrom(path)
	if got.NoToasts || got.SilentToasts {
		t.Errorf("a pre-toasts config loaded as noToasts=%v silentToasts=%v; existing installs would lose their toasts", got.NoToasts, got.SilentToasts)
	}
	if !got.Migrated || !got.NoUpdateCheck || !got.ReportStats {
		t.Errorf("neighboring fields damaged: %+v", got)
	}
}

// TestToastPrefsRoundTrip pins each non-default state on its own: true is the
// choice a widening bug would silently drop, and a field that only survives
// together with the other proves nothing.
func TestToastPrefsRoundTrip(t *testing.T) {
	for name, want := range map[string]appConfig{
		"off":    {ReportStats: true, NoToasts: true, Migrated: true},
		"silent": {ReportStats: true, SilentToasts: true, Migrated: true},
		"both":   {ReportStats: true, NoToasts: true, SilentToasts: true, Migrated: true},
	} {
		path := filepath.Join(t.TempDir(), "floe", "desktop.json")
		if err := saveConfigTo(path, want); err != nil {
			t.Fatalf("%s: saveConfigTo: %v", name, err)
		}
		if got := loadConfigFrom(path); got != want {
			t.Errorf("%s: loadConfigFrom = %+v, want %+v", name, got, want)
		}
	}
}

// TestSettingsFromArgsKeepsToastPrefs: the Settings screen's whole-record save
// knows nothing about the two toast fields, so they must carry over from the
// current record, as NoUpdateCheck does.
func TestSettingsFromArgsKeepsToastPrefs(t *testing.T) {
	cur := appConfig{NoToasts: true, SilentToasts: true, Migrated: true}
	got := settingsFromArgs(cur, "https://floe.example.com/", "", true, false)
	if !got.NoToasts || !got.SilentToasts {
		t.Errorf("settingsFromArgs dropped a toast preference: %+v", got)
	}
	if got.Server != "https://floe.example.com" || !got.HideIP || got.ReportStats || !got.Migrated {
		t.Errorf("argument fields wrong: %+v", got)
	}
}

// TestWithToastsTouchesOnlyItsField and its sound twin: each pure helper flips
// one field and leaves the rest of the record untouched.
func TestWithToastsTouchesOnlyItsField(t *testing.T) {
	base := appConfig{Server: "https://x.test", HideIP: true, NoUpdateCheck: true, SilentToasts: true, Migrated: true}
	off := withToasts(base, false)
	want := base
	want.NoToasts = true
	if off != want {
		t.Errorf("withToasts(false) = %+v, want %+v", off, want)
	}
	if on := withToasts(off, true); on != base {
		t.Errorf("withToasts(true) = %+v, want %+v", on, base)
	}
}

func TestWithToastSoundTouchesOnlyItsField(t *testing.T) {
	base := appConfig{Server: "https://x.test", HideIP: true, NoUpdateCheck: true, NoToasts: true, Migrated: true}
	quiet := withToastSound(base, false)
	want := base
	want.SilentToasts = true
	if quiet != want {
		t.Errorf("withToastSound(false) = %+v, want %+v", quiet, want)
	}
	if loud := withToastSound(quiet, true); loud != base {
		t.Errorf("withToastSound(true) = %+v, want %+v", loud, base)
	}
}

// TestSetToastsAndSoundPersistAndKeepEverythingElse drives the two bound
// setters against the test home (TestMain points desktop.json there): each
// writes its own field, neither disturbs the other or any other setting, and a
// later SetSettings carries both through.
func TestSetToastsAndSoundPersistAndKeepEverythingElse(t *testing.T) {
	a := &App{cfg: appConfig{Server: "https://x.test", HideIP: true, ReportStats: true, NoUpdateCheck: true, Migrated: true}}
	if err := a.SetToasts(false); err != nil {
		t.Fatalf("SetToasts: %v", err)
	}
	if err := a.SetToastSound(false); err != nil {
		t.Fatalf("SetToastSound: %v", err)
	}
	want := appConfig{Server: "https://x.test", HideIP: true, ReportStats: true, NoUpdateCheck: true, NoToasts: true, SilentToasts: true, Migrated: true}
	if got := a.GetSettings(); got != want {
		t.Fatalf("settings after both setters = %+v, want %+v", got, want)
	}
	if got := loadConfig(); got != want {
		t.Fatalf("persisted settings = %+v, want %+v", got, want)
	}
	if err := a.SetSettings("https://y.test", "", false, true); err != nil {
		t.Fatalf("SetSettings: %v", err)
	}
	if got := loadConfig(); !got.NoToasts || !got.SilentToasts || got.Server != "https://y.test" {
		t.Errorf("a whole-record save lost a toast preference: %+v", got)
	}
	if err := a.SetToasts(true); err != nil {
		t.Fatalf("SetToasts(true): %v", err)
	}
	if got := a.GetSettings(); got.NoToasts || !got.SilentToasts {
		t.Errorf("SetToasts(true) = %+v, want notifications back on and sound still off", got)
	}
}
