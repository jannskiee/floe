package peer

// ICE candidate gathering filters. Both are consulted by New when it builds
// the pion SettingEngine; icefilter_test.go has covered them since before this
// file existed.

import (
	"net"
	"strings"
)

// keepICEIP reports whether an interface IP should be used for ICE candidate
// gathering. It drops link-local addresses (IPv4 169.254.0.0/16 and IPv6
// fe80::/10), which are handed out by virtual and VPN adapters (Hyper-V, WSL,
// VMware, Tailscale) and by APIPA auto-config when DHCP fails. Such addresses
// never form a working peer-to-peer path, but pion would otherwise gather a host
// candidate on each and spend 20-30s running connectivity checks that fail with
// "socket operation attempted to an unreachable host" before settling on the
// real interface (often falling back to the relay). Filtering by the link-local
// IP class is unambiguous and safe: it never removes a routable interface.
func keepICEIP(ip net.IP) bool {
	return !ip.IsLinkLocalUnicast()
}

// makeInterfaceAllowFilter builds an ICE interface filter that keeps only the
// interfaces whose name contains one of the given substrings (case-insensitive).
// It is used for the opt-in `--iface` flag so power users on machines with many
// virtual/VPN adapters (VMware, WSL, Tailscale) can pin ICE to their real NIC,
// e.g. `--iface Ethernet`. The link-local IP filter above already handles the
// common case; this is the manual override for the rest. Returns nil (no filter)
// for an empty allowlist so the default behavior is unchanged.
func makeInterfaceAllowFilter(names []string) func(string) bool {
	var wanted []string
	for _, n := range names {
		n = strings.ToLower(strings.TrimSpace(n))
		if n != "" {
			wanted = append(wanted, n)
		}
	}
	if len(wanted) == 0 {
		return nil
	}
	return func(ifName string) bool {
		lower := strings.ToLower(ifName)
		for _, w := range wanted {
			if strings.Contains(lower, w) {
				return true
			}
		}
		return false
	}
}
