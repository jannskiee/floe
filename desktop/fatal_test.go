package main

import (
	"errors"
	"strings"
	"testing"
)

// The failure this whole path exists for: Wails' WebView2 preflight check
// panics with a bare nil pointer dereference, so the cause text says nothing
// about WebView2 and only the stack does. If the hint is ever matched against
// the cause alone, the user gets "runtime error: invalid memory address" and no
// way to act on it, which is the silent-close bug wearing a dialog.
func TestFatalMessageFindsWebView2InTheStackNotTheCause(t *testing.T) {
	cause := errors.New("runtime error: invalid memory address or nil pointer dereference")
	stack := "goroutine 1 [running]:\n" +
		"github.com/wailsapp/wails/v2/internal/webview2runtime.DownloadBootstrapper(...)\n" +
		"\t/pkg/mod/.../webview2runtime/webview2runtime.go:57 +0x1c\n"

	got := fatalMessage(cause, stack)

	if !strings.Contains(got, webview2Hint) {
		t.Fatalf("expected the WebView2 hint when only the stack names it, got:\n%s", got)
	}
	if !strings.Contains(got, "nil pointer dereference") {
		t.Errorf("expected the underlying cause to survive, got:\n%s", got)
	}
}

func TestFatalMessage(t *testing.T) {
	// hint is exercised by TestFatalMessageFindsWebView2InTheStackNotTheCause;
	// these cases all drive the cause alone.
	cases := []struct {
		name     string
		cause    any
		wantHint bool
		contains string
	}{
		{
			name:     "webview2 named in the cause",
			cause:    errors.New("WebView2 runtime not installed"),
			wantHint: true,
			contains: "WebView2 runtime not installed",
		},
		{
			name:     "matching is case insensitive",
			cause:    errors.New("failed to locate webview2 loader"),
			wantHint: true,
		},
		{
			name:     "an unrelated failure gets no hint",
			cause:    errors.New("bind: address already in use"),
			wantHint: false,
			contains: "address already in use",
		},
		{
			name:     "a bare panic value is still reported",
			cause:    "assignment to entry in nil map",
			wantHint: false,
			contains: "assignment to entry in nil map",
		},
		{
			name:     "an empty cause never renders a blank dialog",
			cause:    errors.New(""),
			wantHint: false,
			contains: "unknown error",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := fatalMessage(c.cause, "")

			if !strings.HasPrefix(got, "Floe could not start.") {
				t.Errorf("every fatal message should open by saying so, got:\n%s", got)
			}
			if hasHint := strings.Contains(got, webview2Hint); hasHint != c.wantHint {
				t.Errorf("WebView2 hint present = %v, want %v, in:\n%s", hasHint, c.wantHint, got)
			}
			if c.contains != "" && !strings.Contains(got, c.contains) {
				t.Errorf("expected message to contain %q, got:\n%s", c.contains, got)
			}
		})
	}
}
