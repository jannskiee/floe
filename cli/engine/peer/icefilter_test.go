package peer

import (
	"net"
	"testing"
)

// TestMakeInterfaceAllowFilter verifies the opt-in --iface allowlist: an empty
// list disables the filter (nil), and a non-empty list keeps only interfaces
// whose name contains an allowed substring (case-insensitive).
func TestMakeInterfaceAllowFilter(t *testing.T) {
	if makeInterfaceAllowFilter(nil) != nil {
		t.Fatal("empty allowlist must return a nil filter (default behavior)")
	}
	if makeInterfaceAllowFilter([]string{"", "  "}) != nil {
		t.Fatal("blank-only allowlist must return a nil filter")
	}

	f := makeInterfaceAllowFilter([]string{"Ethernet", "wi-fi"})
	if f == nil {
		t.Fatal("non-empty allowlist must return a filter")
	}
	cases := []struct {
		ifName string
		keep   bool
	}{
		{"Ethernet", true},
		{"Ethernet 2", true},       // substring match
		{"ethernet", true},         // case-insensitive
		{"Wi-Fi", true},            // case-insensitive match of "wi-fi"
		{"Tailscale", false},       // not in the allowlist
		{"VMware Network Adapter VMnet1", false},
		{"vEthernet (WSL)", true},  // contains "ethernet" -> matched by "Ethernet" entry
	}
	for _, c := range cases {
		if got := f(c.ifName); got != c.keep {
			t.Errorf("filter(%q) = %v, want %v", c.ifName, got, c.keep)
		}
	}
}

// TestKeepICEIP verifies the ICE gathering filter drops link-local addresses
// (the virtual/VPN/APIPA junk that stalls connection setup) while keeping every
// routable address a real transfer needs.
func TestKeepICEIP(t *testing.T) {
	cases := []struct {
		name string
		ip   string
		keep bool
	}{
		{"IPv4 APIPA link-local dropped", "169.254.83.107", false},
		{"IPv6 link-local dropped", "fe80::1", false},
		{"private LAN kept", "192.168.5.38", true},
		{"virtual-adapter private IP kept", "192.168.160.1", true}, // not link-local; only names would flag it, which we avoid
		{"other RFC1918 kept", "10.0.0.5", true},
		{"public IP kept", "112.201.205.40", true},
		{"loopback kept", "127.0.0.1", true},
		{"IPv6 global kept", "2606:4700::1111", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ip := net.ParseIP(c.ip)
			if ip == nil {
				t.Fatalf("bad test IP %q", c.ip)
			}
			if got := keepICEIP(ip); got != c.keep {
				t.Fatalf("keepICEIP(%s) = %v, want %v", c.ip, got, c.keep)
			}
		})
	}
}
