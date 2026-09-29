package main

import (
	"strings"
	"testing"
)

// TestBatteryPresent (P11): only Windows' definite "no system battery"
// (BatteryFlag 128) reads as no battery; unknown (255) and every charge
// state, alone or combined, keep the laptop line.
func TestBatteryPresent(t *testing.T) {
	for _, flag := range []byte{0, 1, 2, 4, 8, 9, 10, 12, 255} {
		if !batteryPresent(flag) {
			t.Errorf("BatteryFlag %d reads as no battery", flag)
		}
	}
	for _, flag := range []byte{128, 128 | 8} {
		if batteryPresent(flag) {
			t.Errorf("BatteryFlag %d reads as a battery", flag)
		}
	}
}

// TestPromptOmitsLaptopLineWithoutBattery (P11, D-136 L12): on a PC Windows
// says has no system battery, the prompt carries its real warnings and no
// laptop line, which would be advice about a lid that does not exist.
func TestPromptOmitsLaptopLineWithoutBattery(t *testing.T) {
	setVar(t, &hasBatteryFn, func() bool { return false })
	a := &App{notifyFn: func(string, string) {}}
	a.lane().emitFn = func(string, any) {}
	forceGen(a, 1)
	a.openPrompt(1, RequestPrompt{Files: 2, Warnings: []string{"low-space", "laptop-power"}})
	if got := strings.Join(a.GetRequestLink().Prompt.Warnings, ","); got != "low-space" {
		t.Fatalf("warnings %q on a PC with no battery, want low-space alone", got)
	}
	a.openPrompt(1, RequestPrompt{})
	if got := a.GetRequestLink().Prompt.Warnings; len(got) != 0 {
		t.Fatalf("warnings %q on a PC with no battery and nothing to warn about", got)
	}
	forceState(a, "off", 0)
}
