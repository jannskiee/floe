//go:build windows

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	toast "git.sr.ht/~jackmordaunt/go-toast/v2"
	"git.sr.ht/~jackmordaunt/go-toast/v2/tmpl"
)

// TestToastForIsSilentAndConstant (S-13): the silent toast is exactly a
// title, a body, foreground activation and no sound. Rendered through
// go-toast's own template it is silent, carries no launch value to run on a
// click, and has no image, action or input.
func TestToastForIsSilentAndConstant(t *testing.T) {
	n := toastFor("Floe", "Files received.")
	want := toast.Notification{Title: "Floe", Body: "Files received.", ActivationType: toast.Foreground, Audio: toast.Silent}
	if !reflect.DeepEqual(n, want) {
		t.Fatalf("toastFor = %+v, want %+v", n, want)
	}

	var out bytes.Buffer
	if err := tmpl.XMLTemplate.Execute(&out, &n); err != nil {
		t.Fatalf("rendering the toast: %v", err)
	}
	xml := out.String()
	if !strings.Contains(xml, `<audio silent="true" />`) {
		t.Errorf("the toast is not silent:\n%s", xml)
	}
	if !strings.Contains(xml, `launch=""`) {
		t.Errorf("the toast carries a launch value:\n%s", xml)
	}
	for _, bad := range []string{"<image", "<actions", "<input", "<action ", "ms-winsoundevent"} {
		if strings.Contains(xml, bad) {
			t.Errorf("the toast holds %q:\n%s", bad, xml)
		}
	}
	if !strings.Contains(xml, "<![CDATA[Floe]]>") || !strings.Contains(xml, "<![CDATA[Files received.]]>") {
		t.Errorf("the toast text is not the title and body it was given:\n%s", xml)
	}
}

// TestEnsureToastIconWritesOnlyMissingTempPNG: the icon Windows reads for a
// toast sits in the temp folder, where Windows or a cleaner can remove it.
// Floe restores it only when it is missing and the registry names a .png that
// is a direct child of the temp folder, so a changed registry value can never
// make Floe write anywhere else or over anything.
func TestEnsureToastIconWritesOnlyMissingTempPNG(t *testing.T) {
	prev := toastIconURIFn
	t.Cleanup(func() { toastIconURIFn = prev })

	tmp := os.TempDir()
	inTemp := filepath.Join(tmp, "floe-toast-icon-test.png")
	t.Cleanup(func() { os.Remove(inTemp) })

	toastIconURIFn = func() string { return inTemp }
	ensureToastIcon()
	got, err := os.ReadFile(inTemp)
	if err != nil {
		t.Fatalf("a missing icon in the temp folder was not restored: %v", err)
	}
	if !bytes.Equal(got, toastIconPNG) || !bytes.HasPrefix(got, []byte("\x89PNG\r\n\x1a\n")) {
		t.Fatalf("the restored icon is %d bytes and not the embedded PNG", len(got))
	}

	// An existing file is never touched.
	if err := os.WriteFile(inTemp, []byte("not the embedded icon"), 0o600); err != nil {
		t.Fatal(err)
	}
	ensureToastIcon()
	if got, _ := os.ReadFile(inTemp); string(got) != "not the embedded icon" {
		t.Errorf("an existing icon was overwritten with %d bytes", len(got))
	}

	// Anything that is not a direct child of the temp folder, or not a .png,
	// or empty, is left alone.
	nested := filepath.Join(t.TempDir(), "sub", "icon.png")
	for name, p := range map[string]string{
		"a nested folder":  nested,
		"a parent folder":  filepath.Join(filepath.Dir(tmp), "floe-toast-icon-test.png"),
		"a wrong suffix":   filepath.Join(tmp, "floe-toast-icon-test.exe"),
		"no suffix":        filepath.Join(tmp, "floe-toast-icon-test"),
		"an empty value":   "",
		"a relative value": "floe-toast-icon-test.png",
	} {
		toastIconURIFn = func() string { return p }
		ensureToastIcon()
		if p == "" {
			continue
		}
		if _, err := os.Stat(p); err == nil {
			os.Remove(p)
			t.Errorf("%s: ensureToastIcon wrote %q", name, p)
		}
	}
	if _, err := os.Stat(filepath.Dir(nested)); err == nil {
		t.Errorf("ensureToastIcon created the folder %q", filepath.Dir(nested))
	}
}

// TestToastIconIsSmall keeps the embedded fallback a small PNG: the 1024 px
// app icon is 280 KB and would ride in the binary for a rare repair.
func TestToastIconIsSmall(t *testing.T) {
	if !bytes.HasPrefix(toastIconPNG, []byte("\x89PNG\r\n\x1a\n")) {
		t.Fatal("the embedded toast icon is not a PNG")
	}
	if len(toastIconPNG) > 16*1024 {
		t.Fatalf("the embedded toast icon is %d bytes, want at most 16 KiB", len(toastIconPNG))
	}
}

// TestToastDisplayNameIsConstant (S-14): the name Windows lists for Floe's
// notifications is the constant "Floe", written to the exe's own
// AppUserModelId key. The write goes through a seam so no test touches the
// real registry.
func TestToastDisplayNameIsConstant(t *testing.T) {
	prev := toastWriteFn
	t.Cleanup(func() { toastWriteFn = prev })
	type write struct{ path, name, value string }
	var got []write
	toastWriteFn = func(path, name, value string) error {
		got = append(got, write{path, name, value})
		return nil
	}

	setToastDisplayName()

	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	want := write{`Software\Classes\AppUserModelId\` + filepath.Base(exe), "DisplayName", "Floe"}
	if len(got) != 1 || got[0] != want {
		t.Fatalf("registry writes = %+v, want exactly %+v", got, want)
	}
}
