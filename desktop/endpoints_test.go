package main

import (
	"strings"
	"testing"
	"time"
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

// TestEndpointsWaitForASettingsWrite: runSend, receiveByCode and the request
// lane each take one endpoints() snapshot for the whole transfer, so one that
// starts while a new address is being written must wait for that write and use
// the address being saved, as it did while the setters held a.mu across it.
func TestEndpointsWaitForASettingsWrite(t *testing.T) {
	writing, release := make(chan struct{}), make(chan struct{})
	a := &App{saveConfigFn: func(appConfig) error {
		close(writing)
		<-release
		return nil
	}}
	saved := make(chan error, 1)
	go func() { saved <- a.SetSettings("https://self.test", "", false, true) }()
	<-writing
	got := make(chan string, 1)
	go func() {
		s, _ := a.endpoints()
		got <- s
	}()
	early := ""
	select {
	case early = <-got:
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if err := <-saved; err != nil {
		t.Fatal(err)
	}
	if early != "" {
		t.Fatalf("a transfer starting during the save resolved %q, not the address being saved", early)
	}
	if s := <-got; s != "https://self.test" {
		t.Fatalf("endpoints = %q after the save, want the saved address", s)
	}
}

// TestShareLink guards the property that matters: the room id is the transfer's
// only secret, so it must live in the URL fragment, which browsers never send to
// a server. Anything before the '#' does reach the server, so the room id
// appearing there would leak it into access logs, Referer headers, and analytics.
func TestShareLink(t *testing.T) {
	const (
		base   = "https://floe.one"
		nonce  = "deadbeef"
		roomID = "6f207790-92a6-4662-bb68-4c4059f75139"
	)

	got := shareLink(base, nonce, roomID)

	if want := base + "/?s=" + nonce + "#room=" + roomID; got != want {
		t.Errorf("shareLink = %q, want %q", got, want)
	}

	// The invariant, asserted independently of the exact shape above.
	beforeFragment, _, found := strings.Cut(got, "#")
	if !found {
		t.Fatalf("shareLink = %q, want a '#' fragment", got)
	}
	if strings.Contains(beforeFragment, roomID) {
		t.Errorf("room id leaked into the server-visible part %q", beforeFragment)
	}
	if strings.Contains(got, "?room=") {
		t.Errorf("shareLink = %q, must not use the leaky ?room= form", got)
	}
	if strings.Contains(got, base+"//") {
		t.Errorf("shareLink = %q, has a double slash after the host", got)
	}
}
