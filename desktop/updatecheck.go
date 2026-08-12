package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Once-a-day check for a newer desktop release, surfaced as a dismissible
// notice in the UI. Notice only: nothing is downloaded or installed here.
//
// The check lives on the Go side because the webview's CSP is connect-src
// 'self'. It deliberately reimplements ~80 lines of cli/internal/selfupdate
// rather than sharing them: that package is internal to the cli module and
// stays CLI-private on purpose (`floe update` has no meaning for the desktop
// app), and the desktop's tag scheme needs its own prefix handling anyway.
//
// The endpoint lists /releases instead of /releases/latest: desktop releases
// are published as prereleases with make_latest=false, always, so /latest
// structurally can never return one (see .github/workflows/desktop-release.yml,
// whose header explains why that invariant is load-bearing). This checker is
// the second consumer of that invariant: it keeps prereleases and filters by
// the desktop-v tag prefix instead.
const (
	// per_page=100, not a smaller page: the CLI releases often enough that a
	// dormant desktop tag could fall off a short first page within months, and
	// the failure mode would be a silent "no update" cached daily.
	defaultReleasesURL = "https://api.github.com/repos/jannskiee/floe/releases?per_page=100"
	updateCheckTimeout = 10 * time.Second
	updateCacheTTL     = 24 * time.Hour
)

// UpdateInfo is what the notice shows. Version "" means "show nothing": the
// same single-struct, no-error contract as ProbeResult (Wails' dispatcher
// would null the result whenever an error is non-nil), and here every failure
// (offline, rate-limited, garbage JSON) is deliberately indistinguishable from
// "you are up to date". Returned by value: a nil pointer would generate a
// Promise the frontend dereferences without a null check.
//
// There is no URL field on purpose. The click target is compiled into the
// frontend, so neither a tampered API response nor a hand-edited cache file
// can steer the user's browser anywhere.
type UpdateInfo struct {
	Version string `json:"version"` // full tag, e.g. "desktop-v0.2.3"
}

// releaseEntry is the slice of the GitHub release object the check reads.
type releaseEntry struct {
	TagName    string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
}

// updateCacheEntry mirrors the CLI's update-check cache shape.
type updateCacheEntry struct {
	CheckedAt time.Time `json:"checked_at"`
	Latest    string    `json:"latest"`
}

// CheckForUpdate reports the newest desktop release if it is newer than this
// build, or an empty version when there is nothing to show. The frontend pulls
// this once per launch; the 24h cache makes that at most one network request
// per day. The work happens inside this call (not a background goroutine at
// startup) so the first launch of a day still gets its notice: the frontend
// awaits a promise, and a slow promise costs nothing.
//
// The check never runs at all for dev builds, Store (MSIX) installs (the Store
// updates them itself), or when the user opted out via the Settings toggle or
// FLOE_NO_UPDATE_CHECK=1 (the CLI's documented env var). All four gates sit
// here, before any network I/O, so "turn it off and no request is made at all"
// is literally true.
func (a *App) CheckForUpdate() UpdateInfo {
	a.mu.Lock()
	optedOut := a.cfg.NoUpdateCheck
	a.mu.Unlock()
	optedOut = optedOut || os.Getenv("FLOE_NO_UPDATE_CHECK") == "1"
	return checkForUpdate(version, optedOut, isPackaged(), releasesURL(), updateCachePath())
}

// checkForUpdate is the fully parameterized body, the analogue of
// probeServer's injectable seams. isPackaged is fail-open (a probe hiccup
// reads as unpackaged), so the fallback is "check runs", which at worst shows
// a Store user a pointer to the download page that also links the Store.
func checkForUpdate(current string, optedOut, packaged bool, apiURL, cachePath string) UpdateInfo {
	if current == "dev" || optedOut || packaged {
		return UpdateInfo{}
	}
	latest, ok := readUpdateCache(cachePath, time.Now())
	if !ok {
		var err error
		latest, err = fetchLatestDesktopTag(apiURL)
		if err != nil {
			// Offline, rate-limited, proxied, whatever: silently no notice.
			// The failure is never cached, so the next launch retries.
			return UpdateInfo{}
		}
		writeUpdateCache(cachePath, latest, time.Now())
	}
	if latest != "" && compareDesktopVersions(latest, current) > 0 {
		return UpdateInfo{Version: latest}
	}
	return UpdateInfo{}
}

// fetchLatestDesktopTag lists releases and returns the newest desktop-v tag,
// or "" when none is visible on the page. Non-200 responses are errors, never
// an empty result: GitHub's rate-limit 403 carries a JSON object body that
// must not be mistaken for an empty release list.
func fetchLatestDesktopTag(apiURL string) (string, error) {
	client := &http.Client{Timeout: updateCheckTimeout}
	req, err := http.NewRequest(http.MethodGet, apiURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", &httpStatusError{code: resp.StatusCode}
	}
	var entries []releaseEntry
	if err := json.NewDecoder(resp.Body).Decode(&entries); err != nil {
		return "", err
	}
	return latestDesktopTag(entries), nil
}

type httpStatusError struct{ code int }

func (e *httpStatusError) Error() string { return "unexpected HTTP status " + strconv.Itoa(e.code) }

// latestDesktopTag scans every entry and keeps the numerically newest
// desktop-v tag. CutPrefix is both the filter and the strip: a tag that does
// not cut is not a desktop release, and only the cut remainder ever reaches
// the numeric compare (TrimPrefix("v") would leave "desktop-v2" glued to the
// major digit, so every major version would parse as 0 and a 1.0.0 release
// could never out-compare 0.9.x). Drafts are skipped; prereleases are kept,
// because prerelease is the desktop channel's permanent publishing state. The
// whole list is scanned because /releases is ordered by creation time, not by
// version: a hotfix for an older line can sit above the true newest.
func latestDesktopTag(entries []releaseEntry) string {
	bestTag, bestRest := "", ""
	for _, e := range entries {
		rest, isDesktop := strings.CutPrefix(e.TagName, "desktop-v")
		if !isDesktop || e.Draft {
			continue
		}
		if bestTag == "" || compareVersionParts(rest, bestRest) > 0 {
			bestTag, bestRest = e.TagName, rest
		}
	}
	return bestTag
}

// compareDesktopVersions orders two desktop version strings, tolerating the
// full tag form on either side. Returns >0 when a is newer than b.
func compareDesktopVersions(a, b string) int {
	return compareVersionParts(stripDesktopPrefix(a), stripDesktopPrefix(b))
}

func stripDesktopPrefix(s string) string {
	s = strings.TrimPrefix(s, "desktop-")
	return strings.TrimPrefix(s, "v")
}

// compareVersionParts numerically compares bare X.Y.Z strings. A part that
// fails to parse counts as 0, so a malformed tag can never win over a real
// version: malformed input fails closed to "no notice".
func compareVersionParts(a, b string) int {
	ap := strings.SplitN(a, ".", 3)
	bp := strings.SplitN(b, ".", 3)
	for i := 0; i < 3; i++ {
		var av, bv int
		if i < len(ap) {
			av, _ = strconv.Atoi(ap[i])
		}
		if i < len(bp) {
			bv, _ = strconv.Atoi(bp[i])
		}
		if av != bv {
			if av > bv {
				return 1
			}
			return -1
		}
	}
	return 0
}

// updateCachePath returns the check's cache file, a sibling of desktop.json
// and the CLI's update-check.json in the same floe/ directory. The cache does
// not live in desktop.json: that file is rewritten on every settings change
// and is documented as the wrong home for churn data. "" disables caching but
// never the check itself.
func updateCachePath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "floe", "desktop-update-check.json")
}

// readUpdateCache returns the cached latest tag when the entry is fresh.
// Malformed or expired entries are misses; a torn write self-heals as a miss
// on the next launch.
func readUpdateCache(path string, now time.Time) (string, bool) {
	if path == "" {
		return "", false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	var c updateCacheEntry
	if err := json.Unmarshal(raw, &c); err != nil {
		return "", false
	}
	if now.Sub(c.CheckedAt) > updateCacheTTL {
		return "", false
	}
	return c.Latest, true
}

// writeUpdateCache stores a successful check, atomically (temp+rename, the
// config.go idiom: this file is rewritten daily for years). Best-effort.
func writeUpdateCache(path, latest string, now time.Time) {
	if path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	body, err := json.Marshal(updateCacheEntry{CheckedAt: now, Latest: latest})
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
	}
}

// releasesURL returns the endpoint to list releases from. FLOE_UPDATE_API is a
// test seam: it lets a local simulation point the checker at a mock server
// without recompiling. It can only influence which version STRING is shown;
// the notice's click target is compiled into the frontend.
func releasesURL() string {
	if u := os.Getenv("FLOE_UPDATE_API"); u != "" {
		return u
	}
	return defaultReleasesURL
}
