package main

// The battery question the Receiving view's laptop line asks (power.go),
// answered by Windows. The _windows suffix is the build constraint, on
// purpose; power_other.go is the twin for every other GOOS.

import "unsafe"

// procGetSystemPowerStatus reuses the kernel32 lazy DLL declared in
// clipboard_windows.go (same package main, both windows-only).
var procGetSystemPowerStatus = kernel32.NewProc("GetSystemPowerStatus")

// systemPowerStatus is SYSTEM_POWER_STATUS: four bytes, then two DWORDs.
type systemPowerStatus struct {
	acLineStatus        byte
	batteryFlag         byte
	batteryLifePercent  byte
	systemStatusFlag    byte
	batteryLifeTime     uint32
	batteryFullLifeTime uint32
}

// hasBattery asks GetSystemPowerStatus. A failed call answers true, which
// keeps the laptop line: advice shown on a desktop costs a line, advice
// withheld from a laptop can cost the drop.
func hasBattery() bool {
	var s systemPowerStatus
	if r, _, _ := procGetSystemPowerStatus.Call(uintptr(unsafe.Pointer(&s))); r == 0 {
		return true
	}
	return batteryPresent(s.batteryFlag)
}
