package selfupdate

// Which version is newest, and the on-disk cache that keeps the CLI from
// asking GitHub on every invocation.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// LatestVersion fetches the latest release tag from GitHub (e.g. "v1.2.0").
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
	return c.Latest, true
}

func writeCache(latest string) {
	p := cacheFilePath()
	if p == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(p), 0755)
	data, _ := json.Marshal(cacheEntry{CheckedAt: time.Now(), Latest: latest})
	_ = os.WriteFile(p, data, 0644)
}

// --- download & verify ---

func fetchText(url string) (string, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d fetching %s", resp.StatusCode, url)
	}
	b, err := io.ReadAll(resp.Body)
	return string(b), err
}
