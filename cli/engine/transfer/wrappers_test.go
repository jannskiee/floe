package transfer

// The short entry points the tests in this package call. They live in a test
// file, not in product code, because each passes options with no Messages and
// Closed pump, and a channel from peer.SetupAsSender or SetupAsReceiver needs
// that pump (see SendOptions and ReceiveOptions): in product code the short
// form opens the window the pump exists to close. These tests own their
// channels and have registered nothing on them, which is the case the fallback
// in SendFilesWithOptions and ReceiveFilesWithOptions is for.

import "github.com/pion/webrtc/v4"

// SendFiles is SendFilesWithOptions with the zero SendOptions, which renders
// a terminal progress bar.
func SendFiles(dc *webrtc.DataChannel, paths []string, localVer string) error {
	return SendFilesWithOptions(dc, paths, localVer, SendOptions{})
}

// ReceiveFiles is ReceiveFilesWithOptions with the zero ReceiveOptions, which
// renders a terminal progress bar.
func ReceiveFiles(dc *webrtc.DataChannel, outputDir string, autoAccept bool, localVer string, serverURL string) error {
	return ReceiveFilesWithOptions(dc, outputDir, autoAccept, localVer, serverURL, ReceiveOptions{})
}

// ReceiveFilesWithProgress is ReceiveFilesWithOptions with a progress callback
// only. When onProgress is non-nil, per-chunk progress is reported through it
// and the terminal progress bar is suppressed.
func ReceiveFilesWithProgress(dc *webrtc.DataChannel, outputDir string, autoAccept bool, localVer string, serverURL string, onProgress ProgressFunc) error {
	return ReceiveFilesWithOptions(dc, outputDir, autoAccept, localVer, serverURL, ReceiveOptions{OnProgress: onProgress})
}
