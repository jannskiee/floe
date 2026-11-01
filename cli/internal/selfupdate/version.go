package selfupdate

// Which version is newest, and the on-disk cache that keeps the CLI from
// asking GitHub on every invocation.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ErrUnexpectedTag is the fixed line floe update stops with when the latest
// release's tag is not a plain vX.Y.Z. It never names the tag, which is not
// Floe's own text and can be any length.
var ErrUnexpectedTag = errors.New("The latest release has an unexpected version name, so floe update stopped. Reinstall with the steps at floe.one/docs/cli/installation instead.")

// releaseTag is the one shape of tag this package accepts. A tag arrives from
// GitHub or from the cache file, and goes into the download URLs and the output.
// CompareVersions reads almost anything as a version, so before this check a
// release published under 9.9.9 was offered and installed by every floe, outside
// the rule that keeps a v* tag in place, and a tag holding ../ could walk its URLs
// out of this repository's releases (B1). In Go's regexp $ is the end of the text,
// never a line feed before it, and \d is ASCII only.
var releaseTag = regexp.MustCompile(`^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`)

// IsReleaseTag reports whether tag is exactly vX.Y.Z. A number too large for an
// int fails too: CompareVersions could not order it, and the pattern alone would
// let a 10 KB run of digits through to the output.
func IsReleaseTag(tag string) bool {
	m := releaseTag.FindStringSubmatch(tag)
	if m == nil {
		return false
	}
	for _, n := range m[1:] {
		if _, err := strconv.Atoi(n); err != nil {
			return false
		}
	}
	return true
}

// LatestVersion fetches the latest release tag from GitHub (e.g. "v1.2.0"). Any
// tag that is not a plain vX.Y.Z is refused with ErrUnexpectedTag.
func LatestVersion() (string, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest("GET", apiURL, nil)
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
		return "", fmt.Errorf("GitHub API returned %d", resp.StatusCode)
	}

	var rel struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return "", err
	}
	if rel.TagName == "" {
		return "", fmt.Errorf("no tag_name in GitHub API response")
	}
	if !IsReleaseTag(rel.TagName) {
		return "", ErrUnexpectedTag
	}
	return rel.TagName, nil
}

// CheckAvailable returns the latest version tag if it is newer than current,
// or "" if current is already up-to-date or the check could not complete.
// Results are cached in ~/.config/floe/update-check.json for 24 hours.
// Always returns "" when current == "dev" or FLOE_NO_UPDATE_CHECK=1.
func CheckAvailable(current string) string {
	if current == "dev" || os.Getenv("FLOE_NO_UPDATE_CHECK") == "1" {
		return ""
	}

	if cached, ok := fromCache(); ok {
		if CompareVersions(cached, current) > 0 {
			return cached
		}
		return ""
	}

	ch := make(chan string, 1)
	go func() {
		if v, err := LatestVersion(); err == nil {
			writeCache(v)
			ch <- v
		}
	}()

	select {
	case latest := <-ch:
		if CompareVersions(latest, current) > 0 {
			return latest
		}
	case <-time.After(1 * time.Second):
	}
	return ""
}

// CompareVersions returns 1 if a > b, -1 if a < b, 0 if equal.
// Accepts "vX.Y.Z" or "X.Y.Z" format.
func CompareVersions(a, b string) int {
	a = strings.TrimPrefix(a, "v")
	b = strings.TrimPrefix(b, "v")
	pa := strings.SplitN(a, ".", 3)
	pb := strings.SplitN(b, ".", 3)
	for i := range 3 {
		na, nb := 0, 0
		if i < len(pa) {
			na, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			nb, _ = strconv.Atoi(pb[i])
		}
		if na != nb {
			if na > nb {
				return 1
			}
			return -1
		}
	}
	return 0
}

type cacheEntry struct {
	CheckedAt time.Time `json:"checked_at"`
	Latest    string    `json:"latest"`
}

func cacheFilePath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "floe", "update-check.json")
}

func fromCache() (string, bool) {
	p := cacheFilePath()
	if p == "" {
		return "", false
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return "", false
	}
	var c cacheEntry
	if err := json.Unmarshal(data, &c); err != nil {
		return "", false
	}
	// A negative age (the clock moved backwards since the write, or the file was
	// hand-edited) is a miss too. Without this a future checked_at never expires
	// and the update check is pinned off for good. desktop/updatecheck.go has
	// carried this guard; this is its twin.
	if age := time.Since(c.CheckedAt); age < 0 || age > cacheTTL {
		return "", false
	}
	// A bad value is a miss too (B13): floe 1.11.7 and earlier saved whatever tag
	// GitHub named, and anything on this account can edit the file.
	if !IsReleaseTag(c.Latest) {
		return "", false
	}
	return c.Latest, true
}

func writeCache(latest string) {
	if !IsReleaseTag(latest) {
		return
	}
	p := cacheFilePath()
	if p == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(p), 0755)
	data, _ := json.Marshal(cacheEntry{CheckedAt: time.Now(), Latest: latest})
	_ = os.WriteFile(p, data, 0644)
}
