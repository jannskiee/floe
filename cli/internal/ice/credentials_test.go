package ice

import (
	"reflect"
	"testing"

	"github.com/pion/webrtc/v4"
)

// TestTrimICEServers verifies the defense-in-depth ICE list trim: one URL per
// connectivity class, entry structure and credentials preserved.
func TestTrimICEServers(t *testing.T) {
	t.Run("cloudflare 8-URL shape reduces to 3 URLs across 2 entries", func(t *testing.T) {
		in := []webrtc.ICEServer{
			{URLs: []string{
				"stun:stun.cloudflare.com:3478",
				"stun:stun.cloudflare.com:53",
			}},
			{
				URLs: []string{
					"turn:turn.cloudflare.com:3478?transport=udp",
					"turn:turn.cloudflare.com:3478?transport=tcp",
					"turns:turn.cloudflare.com:5349?transport=tcp",
					"turn:turn.cloudflare.com:53?transport=udp",
					"turn:turn.cloudflare.com:80?transport=tcp",
					"turns:turn.cloudflare.com:443?transport=tcp",
				},
				Username:   "user",
				Credential: "pass",
			},
		}
		got := trimICEServers(in)
		want := []webrtc.ICEServer{
			{URLs: []string{"stun:stun.cloudflare.com:3478"}},
			{
				URLs: []string{
					"turn:turn.cloudflare.com:3478?transport=udp",
					"turns:turn.cloudflare.com:443?transport=tcp",
				},
				Username:   "user",
				Credential: "pass",
			},
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	})

	t.Run("coturn 3-entry shape passes through unchanged", func(t *testing.T) {
		in := []webrtc.ICEServer{
			{URLs: []string{"stun:turn.example.com:3478"}},
			{URLs: []string{"turn:turn.example.com:3478"}, Username: "u", Credential: "c"},
			{URLs: []string{"turns:turn.example.com:5349"}, Username: "u", Credential: "c"},
		}
		got := trimICEServers(in)
		if !reflect.DeepEqual(got, in) {
			t.Fatalf("coturn list must pass through unchanged, got %+v", got)
		}
	})

	t.Run("multiple STUN-only entries collapse to one", func(t *testing.T) {
		in := []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
			{URLs: []string{"stun:stun1.l.google.com:19302"}},
		}
		got := trimICEServers(in)
		if len(got) != 1 || len(got[0].URLs) != 1 {
			t.Fatalf("expected a single STUN URL, got %+v", got)
		}
	})

	t.Run("falls back to turn tcp when no turns URL exists", func(t *testing.T) {
		in := []webrtc.ICEServer{
			{URLs: []string{
				"turn:host:3478?transport=udp",
				"turn:host:80?transport=tcp",
			}, Username: "u", Credential: "c"},
		}
		got := trimICEServers(in)
		want := []webrtc.ICEServer{
			{URLs: []string{
				"turn:host:3478?transport=udp",
				"turn:host:80?transport=tcp",
			}, Username: "u", Credential: "c"},
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	})

	t.Run("returns input unchanged when nothing is classifiable", func(t *testing.T) {
		in := []webrtc.ICEServer{{URLs: []string{"wss:not-an-ice-url"}}}
		got := trimICEServers(in)
		if !reflect.DeepEqual(got, in) {
			t.Fatalf("unclassifiable list must be left alone, got %+v", got)
		}
	})
}

// TestIceURLClass pins the classification rules, including the RFC 7065
// default (turn without a transport param is UDP).
func TestIceURLClass(t *testing.T) {
	cases := map[string]string{
		"stun:host:3478":               "stun",
		"turn:host:3478":               "udp",
		"turn:host:3478?transport=udp": "udp",
		"turn:host:80?transport=tcp":   "tcp",
		"turns:host:443?transport=tcp": "tls",
		"turns:host:5349":              "tls",
		"http://not-ice":               "",
	}
	for u, want := range cases {
		if got := iceURLClass(u); got != want {
			t.Errorf("iceURLClass(%q) = %q, want %q", u, got, want)
		}
	}
}
