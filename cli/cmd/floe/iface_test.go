package main

import (
	"errors"
	"net"
	"testing"

	"github.com/google/uuid"
)

// TestIfaceIsCheckedBeforeTheNetwork: "wifi" is no part of "Wi-Fi".
func TestIfaceIsCheckedBeforeTheNetwork(t *testing.T) {
	const noMatch = "Error: --iface matches no network interface on this computer; check the name, or drop the flag\n"
	const goesOn = "Error: failed to fetch ICE credentials: test: no ICE fetch from https://api.floe.one\n"
	file := sendFile(t)
	room := "https://floe.one/#room=" + uuid.New().String()
	for _, tc := range []struct {
		name    string
		args    []string
		listErr error
		want    string
	}{
		{"send", []string{"send", file, "--iface", "wifi"}, nil, noMatch},
		{"send --to", []string{"send", file, "--to", floeLinkFor(), "--iface", "wifi"}, nil, noMatch},
		{"receive", []string{"receive", room, "--iface", "wifi"}, nil, noMatch},
		{"any case", []string{"send", file, "--iface", "WI-FI"}, nil, goesOn},
		{"any one name", []string{"send", file, "--iface", "wifi, Wi-Fi"}, nil, goesOn},
		{"no list", []string{"send", file, "--iface", "wifi"}, errors.New("no list"), goesOn},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stubCompletionInterfaces(t, []net.Interface{{Name: "Ethernet 2"}, {Name: "Wi-Fi"}}, tc.listErr)
			calls := stubNetwork(t, "")
			t.Cleanup(func() {
				// pflag appends to a slice flag it set before; cobra keeps --to.
				flagIface, rootCmd.PersistentFlags().Lookup("iface").Changed = nil, false
				to := sendCmd.Flags().Lookup("to")
				_ = to.Value.Set("")
				to.Changed = false
				interruptHook.Store(nil)
				resetReceiveStop()
			})
			_, stderr, err := runUpdateCLI(t, tc.args...)
			if err == nil || stderr != tc.want || (tc.want == noMatch && calls.ice.Load() != 0) {
				t.Errorf("got %q after %d ICE fetch(es), want %q", stderr, calls.ice.Load(), tc.want)
			}
		})
	}
}
