package main

// Whether this PC may run on a battery, for the Receiving view's laptop line
// (P11, moved off the prompt by E-94). The line is advice for a laptop ("keep
// this laptop plugged in and open"), so a PC that Windows says has no system
// battery does not get it (D-136 L12); this supersedes E-27's "no power-state
// API is asked". hasBattery is Windows' answer (power_windows.go) and "maybe"
// everywhere else (power_other.go), which keeps the line.

// hasBatteryFn reports whether this PC may run on a battery; a test stands in
// either answer, so no test depends on the machine it runs on.
var hasBatteryFn = hasBattery

// BatteryFlag values of SYSTEM_POWER_STATUS (winbase.h) that decide the line.
const (
	batteryFlagNoSystemBattery = 128
	batteryFlagUnknown         = 255
)

// batteryPresent reads a BatteryFlag: false only for Windows' definite "no
// system battery"; unknown, and every charge state alone or combined, keep
// the line.
func batteryPresent(flag byte) bool {
	return flag == batteryFlagUnknown || flag&batteryFlagNoSystemBattery == 0
}
