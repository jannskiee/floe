package main

import "testing"

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

// TestSnapshotCarriesTheBatteryFact (P11, E-94): the battery answer rides the
// lane's snapshot, from the prompt on through Receiving, where the laptop line
// now lives. It is Go's own fact about this PC, asked once per prompt outside
// the lane lock, and never a prompt warning.
func TestSnapshotCarriesTheBatteryFact(t *testing.T) {
	for _, battery := range []bool{true, false} {
		setVar(t, &hasBatteryFn, func() bool { return battery })
		a := &App{notifyFn: func(string, string) {}, wake: &wakeGuard{onBlock: func() {}, onAllow: func() {}}}
		a.lane().emitFn = func(string, any) {}
		forceGen(a, 1)
		a.openPrompt(1, RequestPrompt{Files: 2})
		if got := a.GetRequestLink(); got.State != "deciding" || got.Battery != battery {
			t.Fatalf("battery %v: deciding snapshot says %v", battery, got.Battery)
		}
		if !a.acceptDrop(1, RequestResult{}) {
			t.Fatal("Accept found the lane gone")
		}
		if got := a.GetRequestLink(); got.State != "receiving" || got.Battery != battery {
			t.Fatalf("battery %v: receiving snapshot says %v", battery, got.Battery)
		}
		forceState(a, "off", 0)
	}
}

// TestMakeLinkForgetsTheBatteryFact: a new link starts from nothing, so a
// fact asked for the last link's prompt never reads as this link's.
func TestMakeLinkForgetsTheBatteryFact(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	l := a.lane()
	l.mu.Lock()
	l.battery = true
	l.mu.Unlock()
	first := makeWaiting(t, a)
	if first.Battery {
		t.Fatal("a fresh link's snapshot still says the last prompt's battery fact")
	}
}
