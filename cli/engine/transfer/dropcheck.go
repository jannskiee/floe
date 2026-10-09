package transfer

// The request-link send's checks on its own files, made after the folder walk
// and before any network: a drop the host would refuse for its file count, or
// for a file whose description cannot fit one control message, is refused
// here with nothing sent (TL-30, TL-31).

import (
	"errors"
)

// MaxDropFiles is the most files one request-link drop may carry. The host
// refuses more (requestMaxFiles in desktop/transfer.go, 10000) and the /r page
// stops at the same number before it sends (MAX_REQUEST_FILES in
// client/lib/request/constants.ts); TestMaxDropFilesMatchesTheOtherSurfaces
// pins it.
const MaxDropFiles = 10000

// The two refusals PrecheckDrop makes. Fixed local text; a caller with its own
// copy matches them with errors.Is.
var (
	// ErrTooManyFiles: the paths hold more than MaxDropFiles files.
	ErrTooManyFiles = errors.New("more files than one drop may carry")
	// ErrMetadataTooLarge: one file's metadata frame, encoded, would be longer
	// than controlMsgMax, which a receiver refuses instead of reading.
	ErrMetadataTooLarge = errors.New("a file's name or folder path is too long to describe in one control message")
)

// PrecheckDrop walks paths exactly as SendFilesWithOptions will (collectFiles)
// and returns how many files that is, or why the drop cannot be sent: a walk
// error as collectFiles words it, ErrNoFiles, ErrTooManyFiles, or
// ErrMetadataTooLarge. localVer is the release string the metadata will carry.
// It reads the file system only, so it runs before anything touches the
// network.
func PrecheckDrop(paths []string, localVer string) (files int, err error) {
	entries, err := collectFiles(paths)
	if err != nil {
		return 0, err
	}
	if len(entries) == 0 {
		return 0, ErrNoFiles
	}
	return precheckEntries(entries, localVer)
}

// precheckEntries is PrecheckDrop after the walk, pure so a test can hand it
// ten thousand and one entries without making them on disk.
func precheckEntries(entries []fileEntry, localVer string) (int, error) {
	n := len(entries)
	if n > MaxDropFiles {
		return n, ErrTooManyFiles
	}
	var totalBytes int64
	for _, e := range entries {
		totalBytes += e.size
	}
	for _, e := range entries {
		if metadataFrameLen(e, n, totalBytes, localVer) > controlMsgMax {
			return n, ErrMetadataTooLarge
		}
	}
	return n, nil
}

// worstCaseFileID stands in for the uuid sendFile gives each file. Every uuid
// is 36 characters of hex digits and hyphens, none of which JSON escapes, so
// any one is the worst case.
const worstCaseFileID = "ffffffff-ffff-ffff-ffff-ffffffffffff"

// metadataFrameLen is how many bytes e's metadata frame will be on the wire:
// the same struct sendFile encodes, with the widest index the drop reaches
// (the last, index equal to total) and this walk's sizes. metadataJSON is the
// measure because it is the wire's encoding: a quote or a backslash costs two
// bytes, <, > and & one, and a character outside the BMP four.
func metadataFrameLen(e fileEntry, total int, totalBytes int64, localVer string) int {
	b := metadataJSON(metadataMsg{
		Type:       "metadata",
		ID:         worstCaseFileID,
		FileName:   e.displayName,
		FileSize:   e.size,
		Index:      total,
		Total:      total,
		TotalBytes: totalBytes,
		Pv:         ProtocolVersion,
		PvMin:      MinProtocolVersion,
		Ver:        localVer,
	})
	return len(b)
}
