//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestToastXMLShape (S-13, deep QA A2-02): the one toast Floe builds is a
// title, a body, foreground activation with an empty launch value (a click
// runs nothing), a short duration, and silence or Windows' default sound.
// Nothing else: no image, action or input.
func TestToastXMLShape(t *testing.T) {
	const want = `<toast activationType="foreground" launch="" duration="short"><visual><binding template="ToastGeneric"><text hint-maxLines="1">Floe</text><text>Files received.</text></binding></visual><audio silent="true" /></toast>`
	if got := toastXML("Floe", "Files received.", true); got != want {
		t.Errorf("silent toast =\n%s\nwant\n%s", got, want)
	}
	wantSound := strings.Replace(want, `<audio silent="true" />`, "", 1)
	if got := toastXML("Floe", "Files received.", false); got != wantSound {
		t.Errorf("sound toast =\n%s\nwant\n%s", got, wantSound)
	}
}

// TestToastXMLTextCannotEndAnElement (A2-02): whatever the text, the toast
// parses to the same elements and attributes, and each <text> holds exactly
// the string it was given. go-toast's own template wraps text in CDATA, which
// a "]]>" ends.
func TestToastXMLTextCannotEndAnElement(t *testing.T) {
	cases := []struct{ title, body string }{
		{`]]><actions><action content="x" arguments="https://example.invalid" activationType="protocol"/></actions><text>`, `$(Start-Process calc) & <b>"q"</b> 'a'`},
		{"line\nbreak\ttab\r", `</text></binding></visual></toast><toast launch="x">`},
		{"", ""},
		{"emoji \U0001F389 and RTL ‮gnp.exe", "&amp; &#x41; <!-- c --> <?pi x?>"},
	}
	for _, tc := range cases {
		for _, silent := range []bool{true, false} {
			doc := toastXML(tc.title, tc.body, silent)
			elems, texts := parseToastXML(t, doc)
			want := "toast[activationType=foreground launch= duration=short] visual binding[template=ToastGeneric] text[hint-maxLines=1] text"
			if silent {
				want += " audio[silent=true]"
			}
			if got := strings.Join(elems, " "); got != want {
				t.Errorf("toastXML(%q, %q, %v) parses to\n%s\nwant\n%s", tc.title, tc.body, silent, got, want)
			}
			if len(texts) != 2 || texts[0] != tc.title || texts[1] != tc.body {
				t.Errorf("toastXML(%q, %q, %v) carries the text %q", tc.title, tc.body, silent, texts)
			}
		}
	}
	// A character XML cannot hold still leaves a toast that parses.
	if elems, _ := parseToastXML(t, toastXML("a\x00b", "￾", true)); len(elems) != 6 {
		t.Errorf("a NUL in the text breaks the toast: %q", elems)
	}
}

// parseToastXML lists each element with its attributes in document order, and
// the text of each <text> element.
func parseToastXML(t *testing.T, doc string) (elems, texts []string) {
	t.Helper()
	d := xml.NewDecoder(strings.NewReader(doc))
	inText := false
	var cur strings.Builder
	for {
		tok, err := d.Token()
		if errors.Is(err, io.EOF) {
			return elems, texts
		}
		if err != nil {
			t.Fatalf("the toast does not parse: %v\n%s", err, doc)
		}
		switch tok := tok.(type) {
		case xml.StartElement:
			e := tok.Name.Local
			if len(tok.Attr) > 0 {
				var attrs []string
				for _, a := range tok.Attr {
					attrs = append(attrs, a.Name.Local+"="+a.Value)
				}
				e += "[" + strings.Join(attrs, " ") + "]"
			}
			elems = append(elems, e)
			inText = tok.Name.Local == "text"
			cur.Reset()
		case xml.CharData:
			if inText {
				cur.Write(tok)
			}
		case xml.EndElement:
			if tok.Name.Local == "text" {
				texts = append(texts, cur.String())
				inText = false
			}
		default:
			t.Fatalf("the toast holds a %T: %s", tok, doc)
		}
	}
}

// TestToastLineNeverBlocks (A2-02): sending a toast returns at once even
// while a push hangs, a full line drops the toast rather than wait, and the
// queued toasts go out in order once the push returns.
func TestToastLineNeverBlocks(t *testing.T) {
	prevIcon := toastIconURIFn
	t.Cleanup(func() { toastIconURIFn = prevIcon })
	toastIconURIFn = func() string { return "" }

	release := make(chan struct{})
	got := make(chan string, 32)
	l := &toastLine{queue: make(chan toastJob, 2), push: func(appID, xml string) error {
		<-release
		got <- xml
		return nil
	}}
	sent := make(chan int, 1)
	go func() {
		queued := 0
		for i := 0; i < 10; i++ {
			if l.send(toastJob{xml: strconv.Itoa(i)}) {
				queued++
			}
		}
		sent <- queued
	}()
	var queued int
	select {
	case queued = <-sent:
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("10 sends waited on a hung push")
	}
	// The goroutine may already hold the first toast, so 2 or 3 are queued.
	if queued < 2 || queued > 3 {
		t.Fatalf("%d of 10 toasts were queued on a line of 2", queued)
	}
	close(release)
	for i := 0; i < queued; i++ {
		select {
		case x := <-got:
			if x != strconv.Itoa(i) {
				t.Fatalf("toast %d went out as %q", i, x)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("toast %d never went out", i)
		}
	}
	select {
	case x := <-got:
		t.Fatalf("a dropped toast went out: %q", x)
	case <-time.After(100 * time.Millisecond):
	}
}

// TestPushToastNeverWaits (A2-02): pushToast returns while the push hangs,
// however many toasts are asked for, so a toast can never hold up the drop
// or the receive that sent it.
func TestPushToastNeverWaits(t *testing.T) {
	prevLine, prevIcon := toasts, toastIconURIFn
	t.Cleanup(func() { toasts, toastIconURIFn = prevLine, prevIcon })
	toastIconURIFn = func() string { return "" }
	hang := make(chan struct{})
	t.Cleanup(func() { close(hang) })
	toasts = &toastLine{queue: make(chan toastJob, toastQueueSize), push: func(appID, xml string) error {
		<-hang
		return nil
	}}
	done := make(chan struct{})
	go func() {
		for i := 0; i < 3*toastQueueSize; i++ {
			pushToast(context.Background(), "Floe", "Files received.", true)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("pushToast waited on a hung push")
	}
}

// TestPushToastUsesThePackageAppID (A2-02): a Store build's toast goes out
// under the package's own AppUserModelID, and an unpackaged build's under ""
// (the exe-name ID Wails registered), each with the toast toastXML builds.
func TestPushToastUsesThePackageAppID(t *testing.T) {
	prevLine, prevID, prevIcon := toasts, toastAppID, toastIconURIFn
	t.Cleanup(func() { toasts, toastAppID, toastIconURIFn = prevLine, prevID, prevIcon })
	toastIconURIFn = func() string { return "" }

	for _, appID := range []string{"JanCarloParedes.FloeDesktop_r1y5w9chaxnzc!FloeDesktop", ""} {
		type pushed struct{ appID, xml string }
		got := make(chan pushed, 1)
		toasts = &toastLine{queue: make(chan toastJob, toastQueueSize), push: func(appID, xml string) error {
			got <- pushed{appID, xml}
			return nil
		}}
		toastAppID = func() string { return appID }
		pushToast(context.Background(), "Floe", "Files received.", true)
		select {
		case p := <-got:
			if p.appID != appID || p.xml != toastXML("Floe", "Files received.", true) {
				t.Errorf("pushed %+v, want app ID %q and the silent toast", p, appID)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("no toast went out for app ID %q", appID)
		}
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
