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
