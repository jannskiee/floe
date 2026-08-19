package transfer

// Progress describes the state of an in-flight transfer for one file. It is
// reported by SendFilesWithProgress and ReceiveFilesWithProgress so a GUI can
// render a live progress bar. The CLI does not use it; it renders a terminal
// progress bar instead.
type Progress struct {
	FileName   string `json:"fileName"`   // sender-supplied name of the current file
	FileIndex  int    `json:"fileIndex"`  // 1-based index of the current file
	FileCount  int    `json:"fileCount"`  // total number of files in the transfer
	FileBytes  int64  `json:"fileBytes"`  // bytes moved so far for the current file
	FileSize   int64  `json:"fileSize"`   // size of the current file
	TotalBytes int64  `json:"totalBytes"` // bytes moved so far across all files
	GrandTotal int64  `json:"grandTotal"` // total bytes across all files (0 if unknown)

	// SavedName is the on-disk name the receiver actually wrote, relative to the
	// output directory, slash-separated. It differs from FileName when the name
	// collided with an existing file (claimPart appends " (1)", " (2)", ...)
	// or was sanitized by safeJoin. Empty on the send side, where no file is
	// written. UIs that open or reveal the received file must use this, not
	// FileName, or a collision makes them act on the pre-existing file.
	SavedName string `json:"savedName"`
}

// ProgressFunc receives progress updates during a transfer. It may be called
// once per chunk, so consumers that cross an expensive boundary (e.g. emitting a
// UI event across the Go/JS bridge) should throttle.
type ProgressFunc func(Progress)
