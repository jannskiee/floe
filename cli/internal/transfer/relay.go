// Relay transfer policy: relayed (TURN) connections are capped, direct
// connections are not. Mirrors the browser client's relay gate
// (client/lib/relay.ts) so every Floe app enforces the same rule.
//
// The cap exists because every relayed byte crosses the TURN server and costs
// real bandwidth, while direct transfers cost nothing. The check is
// sender-side and runs once, before any file bytes move; it fails open when
// the connection path cannot be determined so a detection hiccup never blocks
// a legitimate transfer.

package transfer

import (
	"errors"
	"fmt"

	"github.com/pion/webrtc/v4"
)

// RelaySizeLimit is the maximum total payload (bytes) allowed over a TURN
// relay path. Mirrors RELAY_SIZE_LIMIT in client/lib/relay.ts; keep the two
// in sync. The comparison is strictly greater-than: a payload of exactly the
// limit is allowed, matching the browser.
const RelaySizeLimit int64 = 2 * 1024 * 1024 * 1024 // 2 GB

// ErrRelayOverLimit is returned by the send path when a relayed connection
// would carry more than RelaySizeLimit bytes. Frontends can errors.Is against
// it to show a tailored message.
var ErrRelayOverLimit = errors.New("relayed transfers are capped at 2 GB")

// pathTypeOf reports the selected ICE path for the data channel's connection:
// "relay" when either side of the selected candidate pair is a TURN relay,
// "direct" otherwise. Only meaningful once the connection is established;
// before that it returns an error.
func pathTypeOf(dc *webrtc.DataChannel) (string, error) {
	if dc == nil {
		return "", fmt.Errorf("no data channel")
	}
	sctp := dc.Transport()
	if sctp == nil {
		return "", fmt.Errorf("no SCTP transport")
	}
	dtls := sctp.Transport()
	if dtls == nil {
		return "", fmt.Errorf("no DTLS transport")
	}
	ice := dtls.ICETransport()
	if ice == nil {
		return "", fmt.Errorf("no ICE transport")
	}
	pair, err := ice.GetSelectedCandidatePair()
	if err != nil {
		return "", err
	}
	if pair == nil || pair.Local == nil || pair.Remote == nil {
		return "", fmt.Errorf("no candidate pair selected")
	}
	if pair.Local.Typ == webrtc.ICECandidateTypeRelay || pair.Remote.Typ == webrtc.ICECandidateTypeRelay {
		return "relay", nil
	}
	return "direct", nil
}

// checkRelayGate decides whether a transfer of totalBytes may start on the
// given path type. Pure so it can be unit-tested directly; mirrors
// evaluateRelayGate in client/lib/relay.ts. Only a confirmed relay path
// strictly over the cap blocks; direct and unknown paths always proceed.
func checkRelayGate(pathType string, totalBytes int64) error {
	if pathType == "relay" && totalBytes > RelaySizeLimit {
		return fmt.Errorf("transfer blocked: %w (%s queued). Remove files, or switch to a network that allows a direct connection", ErrRelayOverLimit, formatBytes(totalBytes))
	}
	return nil
}

// pathTypeFn is a seam so tests can stub the ICE-path probe.
var pathTypeFn = pathTypeOf

// relayGate applies the relay size cap for a send about to start on dc. It
// fails open: when the path cannot be determined (nil transports, no selected
// pair yet) the transfer proceeds, because blocking on a detection failure
// would strand legitimate transfers.
func relayGate(dc *webrtc.DataChannel, totalBytes int64) error {
	pathType, err := pathTypeFn(dc)
	if err != nil {
		return nil
	}
	return checkRelayGate(pathType, totalBytes)
}
