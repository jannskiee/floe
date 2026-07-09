package peer

import (
	"net"
	"testing"
)

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
