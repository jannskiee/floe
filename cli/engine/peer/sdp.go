package peer

// SDP reading and rewriting. Both functions are pure string work on a session
// description and hold no connection state.

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

// patchMaxMessageSize injects a=max-message-size into the SDP.
//
// pion/webrtc v3.3.6 does NOT include a=max-message-size in the SDP it
// generates. Per RFC 8841 §5, when the attribute is absent the remote peer
// MUST assume a default of 65536 bytes. Chrome enforces this default: any
// call to RTCDataChannel.send() with a payload larger than 65536 bytes throws
// "Failure to send data" (TypeError per the WebRTC spec §6.2 step 4).
//
// The browser's chunk size starts at 160 KB (chunkSizeRef = 160*1024), so
// every single chunk send fails. The fix is to explicitly advertise a large
// max-message-size (1 GB) after the a=sctp-port line that pion DOES emit.
// pion/sctp transparently handles SCTP-level fragmentation for large messages.
func patchMaxMessageSize(sdp string) string {
	const maxMsgAttr = "a=max-message-size:1073741824\r\n" // 1 GB

	// If the attribute already exists (future pion versions), replace it.
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
