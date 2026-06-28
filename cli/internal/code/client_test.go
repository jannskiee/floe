package code

import "testing"

// Resolve must accept both the new fragment links (#room=) and the older query
// links (?room=) so that a link from either the browser or the CLI works in
// `floe receive`. The URL branch parses locally and never touches the network.
func TestResolveURL(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"fragment", "https://floe.one/#room=abc-123", "abc-123"},
		{"query", "https://floe.one/?room=abc-123", "abc-123"},
		{"query without slash", "https://floe.one?room=abc-123", "abc-123"},
		{"local fragment", "http://localhost:3000/#room=xyz", "xyz"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Resolve("", tc.input)
			if err != nil {
				t.Fatalf("Resolve(%q) returned error: %v", tc.input, err)
			}
			if got != tc.want {
				t.Fatalf("Resolve(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestResolveURLWithoutRoom(t *testing.T) {
	if _, err := Resolve("", "https://floe.one/about"); err == nil {
		t.Fatal("expected an error for a URL with no room id, got nil")
	}
}
