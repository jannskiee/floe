package main

import (
	"testing"
	"unsafe"
)

// TestSystemPowerStatusIsTwelveBytes: SYSTEM_POWER_STATUS is four bytes and
// two DWORDs; a wrong size would let GetSystemPowerStatus write past the
// struct. The call itself answers on any PC (its value is this machine's).
func TestSystemPowerStatusIsTwelveBytes(t *testing.T) {
	if n := unsafe.Sizeof(systemPowerStatus{}); n != 12 {
		t.Fatalf("systemPowerStatus is %d bytes, want 12", n)
	}
	_ = hasBattery()
}
