package peer

// SDP reading and rewriting. Every function here is pure string work on a
// session description and holds no connection state.

import "strings"

// extractFingerprint returns the value of the first "a=fingerprint:" attribute
// in an SDP (e.g. "sha-256 AB:CD:..."), or "" if absent.
func extractFingerprint(sdp string) string {
	for _, line := range strings.Split(sdp, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "a=fingerprint:") {
			return strings.TrimSpace(line[len("a=fingerprint:"):])
		}
	}
	return ""
}

// filterSDPCandidates keeps at most room of the description's a=candidate
// lines, in order, and only those whose value (the line without "a=", which
// reads as a trickled candidate's Candidate string does) is at most
// maxCandidateBytes. Every other line, a=end-of-candidates included, comes back
// byte for byte with its line ending. It returns the description and how many
// candidate lines it kept, for the caller to count against maxRemoteCandidates.
func filterSDPCandidates(sdp string, room int) (string, int) {
	var b strings.Builder
	b.Grow(len(sdp))
	kept := 0
	for _, line := range strings.SplitAfter(sdp, "\n") {
		value := strings.TrimRight(line, "\r\n")
		if value == "a=candidate" || strings.HasPrefix(value, "a=candidate:") {
			if kept >= room || len(value)-len("a=") > maxCandidateBytes {
				continue
			}
			kept++
		}
		b.WriteString(line)
	}
	return b.String(), kept
}

// patchMaxMessageSize pins a=max-message-size to 1 GB in the SDP.
//
// Per RFC 8841 section 5 the attribute tells the remote peer how large a
// message this side accepts, and when it is absent the remote peer must assume
// 65536 bytes. Chrome enforces whichever applies: RTCDataChannel.send() past it
// throws "Failure to send data" (a TypeError per the WebRTC spec), and the
// browser sender's chunks run up to MAX_CHUNK, 256 KB, in
// client/lib/transfer/protocol.ts.
//
// pion/webrtc v3 omitted the attribute, and injecting one after the
// a=sctp-port line was the fix. pion v4 (v4.2.19 in go.mod) emits it in every
// description it generates (addDataMediaSection in its sdp.go) with the
// SettingEngine ceiling, 1073741823 by default, so the replace branch below is
// the live path and the inject branch only covers an SDP that lacks the
// attribute. pion/sctp fragments large messages itself.
func patchMaxMessageSize(sdp string) string {
	const maxMsgAttr = "a=max-message-size:1073741824\r\n" // 1 GB

	// pion v4 always emits the attribute, so this is the path taken today.
	if strings.Contains(sdp, "a=max-message-size:") {
		lines := strings.Split(sdp, "\r\n")
		for i, line := range lines {
			if strings.HasPrefix(line, "a=max-message-size:") {
				lines[i] = "a=max-message-size:1073741824"
			}
		}
		return strings.Join(lines, "\r\n")
	}

	// Otherwise inject it right after a=sctp-port:5000
	return strings.Replace(
		sdp,
		"a=sctp-port:5000\r\n",
		"a=sctp-port:5000\r\n"+maxMsgAttr,
		1,
	)
}
