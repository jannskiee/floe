package main

// Which server and web app this build talks to, and the settings that decide
// it. endpoints_test.go already tested this seam before the file existed.

import (
	"github.com/jannskiee/floe/cli/engine/serverurl"
)

// defaultServer is the production Floe signaling server, used unless Settings
// names another one. On the default the desktop app talks to the same
// infrastructure as the browser and CLI, so transfers interoperate; point it at
// a self-hosted server and it interoperates with peers on that server instead.
const defaultServer = "https://api.floe.one"

// shareLink builds the browser link for a send. The room id is the transfer's only
// secret, so it goes in the URL fragment: browsers never send a fragment to a
// server, strip it from the Referer header, and ignore it in analytics. The nonce
// goes in the query instead. It carries no information, and it makes every link a
// distinct document so a phone that already has Floe open joins the new room rather
// than reusing a stale tab. Mirrors client/components/P2PTransfer.tsx.
func shareLink(base, nonce, roomID string) string {
	return base + "/?s=" + nonce + "#room=" + roomID
}

// endpoints resolves the signaling origin and the share-link origin to use for
// one transfer.
//
// Callers take a single snapshot and pass it down, so changing the setting while
// a transfer is running cannot split that transfer across two servers.
func (a *App) endpoints() (server, web string) {
	a.mu.Lock()
	cfg := a.cfg
	a.mu.Unlock()

	server = cfg.Server
	if server == "" {
		server = defaultServer
	}
	web = cfg.Web
	if web == "" {
		// serverurl.Web maps the production and local-dev pairs to their web
		// hosts and leaves a one-domain self-hosted address alone. Shared with
		// the CLI so both surfaces emit identical links.
		web = serverurl.Web(server)
	}
	return server, web
}

// GetSettings returns every persisted setting for the Settings screen. Empty
// address fields mean "using the Floe defaults" and render as placeholders.
//
// When Migrated is false the toggles have never been written here, and the
// frontend imports them once from the localStorage keys they used to live in.
func (a *App) GetSettings() appConfig {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg
}

// SetSettings persists the whole settings record. Either address may be empty to
// fall back to the default. It does not verify the address; TestServer does that
// on demand, so a user can save an address for a server that is not up yet.
//
// Writing always marks the record migrated, so the one-time localStorage import
// cannot run twice and re-resurrect a preference the user has since changed.
func (a *App) SetSettings(server, web string, hideIP, reportStats bool) error {
	// The whole read-modify-write holds the lock. Wails dispatches every bound
	// call on its own goroutine, and this method races SetCheckUpdates when the
	// Settings screen fires unawaited saves on quick toggle flips; a snapshot
	// taken before the other writer's write-back would silently resurrect the
	// stale record. saveConfig is a small atomic write, cheap to hold across.
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg := settingsFromArgs(a.cfg, server, web, hideIP, reportStats)
	if err := saveConfig(cfg); err != nil {
		return err
	}
	a.cfg = cfg
	return nil
}

// settingsFromArgs builds the record SetSettings persists. Fields owned by
// other setters (NoUpdateCheck, via SetCheckUpdates) are carried over from the
// current record: SetSettings used to construct a fresh appConfig from only
// its arguments, which silently zeroed any field the Settings screen did not
// know about on every save.
func settingsFromArgs(cur appConfig, server, web string, hideIP, reportStats bool) appConfig {
	return normalizeConfig(appConfig{
		Server:        server,
		Web:           web,
		HideIP:        hideIP,
		ReportStats:   reportStats,
		NoUpdateCheck: cur.NoUpdateCheck,
		Migrated:      true,
	})
}

// SetCheckUpdates persists the update-check toggle alone, leaving every other
// setting untouched. enabled=true is the shipped default (NoUpdateCheck=false).
// Holds the lock across the whole read-modify-write for the same reason
// SetSettings does: the two setters race on quick toggle flips.
func (a *App) SetCheckUpdates(enabled bool) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg := a.cfg
	cfg.NoUpdateCheck = !enabled
	if err := saveConfig(cfg); err != nil {
		return err
	}
	a.cfg = cfg
	return nil
}
