package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// releasesServer serves a canned GitHub-style release list and counts hits, so
// the opt-out tests can assert "no request is made at all" literally.
func releasesServer(t *testing.T, entries []releaseEntry) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_ = json.NewEncoder(w).Encode(entries)
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

// mixedReleases mirrors the real repository shape: CLI releases interleaved
// with desktop prereleases, plus a draft that must never win.
var mixedReleases = []releaseEntry{
	{TagName: "v1.10.0"},
	{TagName: "desktop-v0.2.9", Prerelease: true},
	{TagName: "desktop-v0.3.0", Draft: true, Prerelease: true},
	{TagName: "v1.9.1"},
	{TagName: "desktop-v0.2.10", Prerelease: true},
	{TagName: "desktop-v0.2.2", Prerelease: true},
}

func TestLatestDesktopTagPicksNewestDesktopRelease(t *testing.T) {
	// 0.2.10 must beat 0.2.9 numerically (lexically it would lose), and the
	// scan must not stop at the first desktop match: the list is ordered by
	// creation time, and 0.2.9 sits above 0.2.10 here on purpose.
	if got := latestDesktopTag(mixedReleases); got != "desktop-v0.2.10" {
		t.Errorf("latestDesktopTag = %q, want desktop-v0.2.10", got)
	}
}

func TestLatestDesktopTagSkipsDraftsAndForeignTags(t *testing.T) {
	// The draft desktop-v0.3.0 is newer than everything and must still lose.
	if got := latestDesktopTag(mixedReleases); got == "desktop-v0.3.0" {
		t.Error("a draft release won the scan")
	}
	// CLI-only list: no desktop tag at all.
	if got := latestDesktopTag([]releaseEntry{{TagName: "v1.10.0"}, {TagName: "v1.9.1"}}); got != "" {
		t.Errorf("latestDesktopTag over CLI releases = %q, want empty", got)
	}
	// Prerelease flag alone must not exclude: it is the desktop's permanent
	// publishing state.
	only := []releaseEntry{{TagName: "desktop-v0.2.2", Prerelease: true}}
	if got := latestDesktopTag(only); got != "desktop-v0.2.2" {
		t.Errorf("a prerelease desktop tag was excluded: %q", got)
	}
}

func TestLatestDesktopTagToleratesMalformedTags(t *testing.T) {
	entries := []releaseEntry{
		{TagName: "desktop-vNext"},
		{TagName: "desktop-v"},
		{TagName: "desktop-v0.1.0", Prerelease: true},
	}
	// Malformed tags parse as 0.0.0 and can never beat a real version.
	if got := latestDesktopTag(entries); got != "desktop-v0.1.0" {
		t.Errorf("latestDesktopTag = %q, want desktop-v0.1.0", got)
	}
}

func TestCompareDesktopVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"desktop-v0.2.3", "desktop-v0.2.2", 1},
		{"desktop-v0.2.2", "desktop-v0.2.2", 0},
		{"desktop-v0.2.1", "desktop-v0.2.2", -1},
		// The major bump is the case a prefix-blind compare gets wrong
		// forever: "desktop-v1" glued together parses as major 0.
		{"desktop-v1.0.0", "desktop-v0.9.9", 1},
		{"desktop-v0.2.10", "desktop-v0.2.9", 1},
		// Mixed forms: full tag vs bare version vs v-prefixed.
		{"desktop-v0.3.0", "0.2.2", 1},
		{"v0.2.2", "desktop-v0.2.2", 0},
		// Malformed input fails closed (parses as 0.0.0).
		{"desktop-vNext", "desktop-v0.0.1", -1},
		{"dev", "desktop-v0.2.2", -1},
	}
	for _, tc := range cases {
		if got := compareDesktopVersions(tc.a, tc.b); got != tc.want {
			t.Errorf("compareDesktopVersions(%q, %q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestCheckForUpdateFindsNewerRelease(t *testing.T) {
	srv, _ := releasesServer(t, mixedReleases)
	cache := filepath.Join(t.TempDir(), "cache.json")

	got := checkForUpdate("desktop-v0.2.2", false, false, srv.URL, cache)
	if got.Version != "desktop-v0.2.10" {
		t.Errorf("CheckForUpdate = %+v, want desktop-v0.2.10", got)
	}
}

func TestCheckForUpdateReturnsNothingWhenCurrent(t *testing.T) {
	srv, _ := releasesServer(t, mixedReleases)

	// Equal to the newest listed release: no notice.
	if got := checkForUpdate("desktop-v0.2.10", false, false, srv.URL, filepath.Join(t.TempDir(), "c.json")); got.Version != "" {
		t.Errorf("up-to-date build got a notice: %+v", got)
	}
	// Newer than everything listed (a yanked release, or a build from a tag
	// that is not published yet): no notice either.
	if got := checkForUpdate("desktop-v0.4.0", false, false, srv.URL, filepath.Join(t.TempDir(), "c2.json")); got.Version != "" {
		t.Errorf("future build got a notice: %+v", got)
	}
}

// TestCheckForUpdateHonorsEveryOptOut asserts the gates sit before any network
// I/O: the docs promise "turn it off and no request is made at all".
func TestCheckForUpdateHonorsEveryOptOut(t *testing.T) {
	cases := []struct {
		name               string
		current            string
		optedOut, packaged bool
	}{
		{"dev build", "dev", false, false},
		{"opted out", "desktop-v0.2.2", true, false},
		{"store build", "desktop-v0.2.2", false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, hits := releasesServer(t, mixedReleases)
			got := checkForUpdate(tc.current, tc.optedOut, tc.packaged, srv.URL, filepath.Join(t.TempDir(), "c.json"))
			if got.Version != "" {
				t.Errorf("gated check returned %+v", got)
			}
			if hits.Load() != 0 {
				t.Errorf("gated check made %d requests, want 0", hits.Load())
			}
		})
	}
}

// TestCheckForUpdateSwallowsServerFailures pins two properties at once: every
// failure is an empty result (never a crash, never a false notice), and a
// failure is never cached, so the next launch retries.
func TestCheckForUpdateSwallowsServerFailures(t *testing.T) {
	cache := filepath.Join(t.TempDir(), "cache.json")

	t.Run("rate limited 403", func(t *testing.T) {
		// GitHub's rate-limit body is a JSON object; it must be an error, not
		// an empty release list.
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"API rate limit exceeded"}`))
		}))
		defer srv.Close()
		if got := checkForUpdate("desktop-v0.1.0", false, false, srv.URL, cache); got.Version != "" {
			t.Errorf("403 produced a notice: %+v", got)
		}
	})
	t.Run("garbage body", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte("<!doctype html>"))
		}))
		defer srv.Close()
		if got := checkForUpdate("desktop-v0.1.0", false, false, srv.URL, cache); got.Version != "" {
			t.Errorf("garbage body produced a notice: %+v", got)
		}
	})
	t.Run("unreachable server", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
		srv.Close() // deliberately dead
		if got := checkForUpdate("desktop-v0.1.0", false, false, srv.URL, cache); got.Version != "" {
			t.Errorf("dead server produced a notice: %+v", got)
		}
	})

	if _, err := os.Stat(cache); !os.IsNotExist(err) {
		t.Error("a failed check wrote the cache; the next launch would not retry")
	}
}

func TestCheckForUpdateUsesFreshCacheWithoutNetwork(t *testing.T) {
	srv, hits := releasesServer(t, mixedReleases)
	cache := filepath.Join(t.TempDir(), "cache.json")
	writeUpdateCache(cache, "desktop-v0.2.5", time.Now())

	got := checkForUpdate("desktop-v0.2.2", false, false, srv.URL, cache)
	if got.Version != "desktop-v0.2.5" {
		t.Errorf("cached check = %+v, want the cached desktop-v0.2.5", got)
	}
	if hits.Load() != 0 {
		t.Errorf("fresh cache still made %d requests", hits.Load())
	}
}

func TestCheckForUpdateRefetchesAfterExpiredTTL(t *testing.T) {
	srv, hits := releasesServer(t, mixedReleases)
	cache := filepath.Join(t.TempDir(), "cache.json")

	// Seed an expired entry by writing it directly with an old timestamp.
	body, _ := json.Marshal(updateCacheEntry{CheckedAt: time.Now().Add(-25 * time.Hour), Latest: "desktop-v0.2.5"})
	if err := os.WriteFile(cache, body, 0o600); err != nil {
		t.Fatal(err)
	}

	got := checkForUpdate("desktop-v0.2.2", false, false, srv.URL, cache)
	if got.Version != "desktop-v0.2.10" {
		t.Errorf("expired cache returned %+v, want the refetched desktop-v0.2.10", got)
	}
	if hits.Load() != 1 {
		t.Errorf("expired cache made %d requests, want 1", hits.Load())
	}

	// The refetch must have refreshed the cache.
	if latest, ok := readUpdateCache(cache, time.Now()); !ok || latest != "desktop-v0.2.10" {
		t.Errorf("cache after refetch = %q ok=%v, want desktop-v0.2.10", latest, ok)
	}
}

func TestCheckForUpdateSurvivesCorruptCache(t *testing.T) {
	srv, hits := releasesServer(t, mixedReleases)
	cache := filepath.Join(t.TempDir(), "cache.json")
	if err := os.WriteFile(cache, []byte("{torn"), 0o600); err != nil {
		t.Fatal(err)
	}

	got := checkForUpdate("desktop-v0.2.2", false, false, srv.URL, cache)
	if got.Version != "desktop-v0.2.10" {
		t.Errorf("corrupt cache returned %+v, want a live refetch", got)
	}
	if hits.Load() != 1 {
		t.Errorf("corrupt cache made %d requests, want 1", hits.Load())
	}
}

// TestUpdateCachePathIsSiblingOfSettings guards the file placement contract:
// same floe/ dir as desktop.json and the CLI's update-check.json, distinct name.
func TestUpdateCachePathIsSiblingOfSettings(t *testing.T) {
	p := updateCachePath()
	if p == "" {
		t.Skip("no user config dir on this system")
	}
	if filepath.Base(p) != "desktop-update-check.json" || filepath.Base(filepath.Dir(p)) != "floe" {
		t.Errorf("updateCachePath() = %q, want .../floe/desktop-update-check.json", p)
	}
}
