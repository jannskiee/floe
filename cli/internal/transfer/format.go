package transfer

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/schollz/progressbar/v3"
)

func formatBytes(n int64) string {
	if n == 0 {
		return "0 Bytes"
	}
	units := []string{"Bytes", "KB", "MB", "GB", "TB"}
	k := 1024.0
	i := int(math.Log(float64(n)) / math.Log(k))
	if i >= len(units) {
		i = len(units) - 1
	}
	val := float64(n) / math.Pow(k, float64(i))
	// Trim trailing zeros after decimal (e.g. "1.20 GB" → "1.2 GB")
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.2f", val), "0"), ".") + " " + units[i]
}

func formatSpeed(bytesPerSec float64) string {
	if !isFinitePositive(bytesPerSec) {
		return ""
	}
	if bytesPerSec >= 1024*1024 {
		return fmt.Sprintf("%.1f MB/s", bytesPerSec/1024/1024)
	}
	return fmt.Sprintf("%.1f KB/s", bytesPerSec/1024)
}

func formatDuration(d time.Duration) string {
	secs := int(d.Seconds())
	if secs < 0 {
		secs = 0
	}
	if secs < 60 {
		return fmt.Sprintf("%ds", secs)
	}
	if secs < 3600 {
		return fmt.Sprintf("%dm %ds", secs/60, secs%60)
	}
	return fmt.Sprintf("%dh %dm", secs/3600, (secs%3600)/60)
}

func pluralize(n int, word string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", word)
	}
	return fmt.Sprintf("%d %ss", n, word)
}

func truncateName(name string, maxLen int) string {
	if len(name) <= maxLen {
		return name
	}
	return name[:maxLen-1] + "…"
}

func newProgressBar(size int64, index, total int, name string) *progressbar.ProgressBar {
	return progressbar.NewOptions64(
		size,
		progressbar.OptionSetDescription(
			fmt.Sprintf("  [%d/%d] %s", index, total, truncateName(name, 30)),
		),
		// Size the bar to the terminal width so the whole line always fits.
		// A fixed width could overflow a narrow window; on Windows the library
		// clears with a bare "\r", so a wrapped line scrolls a new row on every
		// redraw (one line per percentage). Full width keeps it on one line and
		// falls back to an 80-column layout when stdout is not a TTY.
		progressbar.OptionFullWidth(),
		// Default throttle is 0, so the bar re-renders (and fsyncs) on every
		// chunk. Cap redraws to keep the display smooth and cut I/O; the final
		// 100% still renders because render() bypasses the throttle at max.
		progressbar.OptionThrottle(65*time.Millisecond),
		progressbar.OptionShowBytes(true),
		progressbar.OptionSetTheme(progressbar.Theme{
			Saucer:        "█",
			SaucerPadding: "░",
			BarStart:      "[",
			BarEnd:        "]",
		}),
	)
}

const divider = "  ─────────────────────────────────────────────────"

// PrintBox prints a divider-bordered block of aligned label/value rows.
// It does NOT print a leading blank line — callers add spacing as needed.
func PrintBox(rows [][2]string) {
	maxLabel := 0
	for _, r := range rows {
		if len(r[0]) > maxLabel {
			maxLabel = len(r[0])
		}
	}
	fmt.Println(divider)
	for _, r := range rows {
		pad := strings.Repeat(" ", maxLabel-len(r[0]))
		fmt.Printf("  %s%s   %s\n", r[0], pad, r[1])
	}
	fmt.Println(divider)
}

// printSummary prints a boxed block with aligned label/value rows, preceded by
// a blank line. Used for the "Sent" / "Received" summaries at transfer end.
func printSummary(rows [][2]string) {
	fmt.Println()
	PrintBox(rows)
}

// Summary holds pre-computed file-list metadata for display before a send.
type Summary struct {
	Files      int
	TotalBytes int64
	Label      string // e.g. "report.pdf · 2.1 MB" or "5 files · 127.3 MB"
}

// Summarize walks paths (same logic as SendFiles) and returns a Summary for
// pre-transfer display. Single files show their name; multiple files show the
// count.
func Summarize(paths []string) (Summary, error) {
	files, err := collectFiles(paths)
	if err != nil {
		return Summary{}, err
	}
	if len(files) == 0 {
		return Summary{}, fmt.Errorf("no files to send")
	}
	var total int64
	for _, f := range files {
		total += f.size
	}
	var label string
	if len(files) == 1 {
		label = files[0].displayName + " · " + formatBytes(total)
	} else {
		label = pluralize(len(files), "file") + " · " + formatBytes(total)
	}
	return Summary{Files: len(files), TotalBytes: total, Label: label}, nil
}

func isFinitePositive(f float64) bool {
	return !math.IsNaN(f) && !math.IsInf(f, 0) && f > 0
}
