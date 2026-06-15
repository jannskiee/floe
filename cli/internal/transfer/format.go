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
		progressbar.OptionSetWidth(30),
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

// printSummary prints a boxed block with aligned label/value rows.
// rows is a slice of [2]string{label, value} pairs.
func printSummary(rows [][2]string) {
	// Find longest label for alignment
	maxLabel := 0
	for _, r := range rows {
		if len(r[0]) > maxLabel {
			maxLabel = len(r[0])
		}
	}
	fmt.Println()
	fmt.Println(divider)
	for _, r := range rows {
		pad := strings.Repeat(" ", maxLabel-len(r[0]))
		fmt.Printf("  %s%s   %s\n", r[0], pad, r[1])
	}
	fmt.Println(divider)
}

func isFinitePositive(f float64) bool {
	return !math.IsNaN(f) && !math.IsInf(f, 0) && f > 0
}
