package main

import (
	"strings"
	"testing"
)

// TestEndpointsDefaults proves an untouched install still talks to Floe's own
// servers, so adding the setting cannot regress the out-of-the-box experience.
func TestEndpointsDefaults(t *testing.T) {
	server, web := (&App{}).endpoints()

	if server != defaultServer {
		t.Errorf("server = %q, want %q", server, defaultServer)
	}
	if want := "https://floe.one"; web != want {
		t.Errorf("web = %q, want %q", web, want)
	}
}

// TestEndpointsSelfHosted covers the layouts a self-hoster can land in. The
// one-domain case is the one the reverse-proxy guide recommends, and it must not
// need the second field filled in.
func TestEndpointsSelfHosted(t *testing.T) {
	cases := []struct {
		name       string
		cfg        appConfig
		wantServer string
		wantWeb    string
	}{
		{
			name:       "one domain derives the web origin",
			cfg:        appConfig{Server: "https://floe.example.com"},
			wantServer: "https://floe.example.com",
			wantWeb:    "https://floe.example.com",
		},
		{
			name:       "split hosts need the override",
			cfg:        appConfig{Server: "https://api.example.com", Web: "https://app.example.com"},
			wantServer: "https://api.example.com",
			wantWeb:    "https://app.example.com",
		},
		{
			name:       "local dev pair is special-cased",
			cfg:        appConfig{Server: "http://localhost:3001"},
			wantServer: "http://localhost:3001",
			wantWeb:    "http://localhost:3000",
		},
		{
			name:       "web override alone still uses the default server",
			cfg:        appConfig{Web: "https://app.example.com"},
			wantServer: defaultServer,
			wantWeb:    "https://app.example.com",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server, web := (&App{cfg: tc.cfg}).endpoints()
			if server != tc.wantServer {
				t.Errorf("server = %q, want %q", server, tc.wantServer)
			}
			if web != tc.wantWeb {
				t.Errorf("web = %q, want %q", web, tc.wantWeb)
			}
		})
	}
}

// TestEndpointsFeedShareLinkCleanly is the composed property: whatever endpoints
// returns has to survive shareLink, which appends "/?s=". A trailing slash that
// slipped through would produce "//?s=" and a link that does not open.
func TestEndpointsFeedShareLinkCleanly(t *testing.T) {
	for _, cfg := range []appConfig{
		{Server: "https://floe.example.com/"},
		{Server: "https://api.example.com//", Web: "https://app.example.com///"},
		{Server: " http://localhost:3001/ "},
	} {
		_, web := (&App{cfg: normalizeConfig(cfg)}).endpoints()
		link := shareLink(web, "deadbeef", "room-1")
		if strings.Contains(link, "//?s=") {
			t.Errorf("cfg %+v produced a doubled slash: %q", cfg, link)
		}
	}
}
