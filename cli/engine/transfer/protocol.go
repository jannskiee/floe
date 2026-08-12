package transfer

import "fmt"

// ProtocolVersion is the highest wire protocol version this build speaks.
// MinProtocolVersion is the lowest it still supports.
//
// Bump policy: increment ProtocolVersion on any breaking wire change (e.g. a
// mandatory new field old receivers cannot ignore, or a removed field they
// require). Raise MinProtocolVersion only when deliberately dropping support
// for an old wire format. Never tie either constant to the floe release version
// (1.x.y) - they are independent.
const (
	ProtocolVersion    = 1
	MinProtocolVersion = 1
)

// incompatibleMsg is sent by the receiver to the sender when their protocol
// version ranges do not overlap. Sent as binary so old senders that do not
// recognize the type treat it as a small JSON blob and drop it safely.
type incompatibleMsg struct {
	Type   string `json:"type"`
	Reason string `json:"reason"`
	Pv     int    `json:"pv"`
	PvMin  int    `json:"pvMin"`
	Ver    string `json:"ver,omitempty"`
}

// CheckCompat reports whether two peers can transfer files given their
// advertised protocol version ranges [localMin, localMax] and [remoteMin,
// remoteMax]. A zero in remoteMin or remoteMax indicates a legacy peer that
// omitted the field; it is treated as protocol version 1.
//
// Returns ok=true when the ranges overlap.
// localTooOld=true means this peer must update; false means the remote must.
func CheckCompat(localMin, localMax, remoteMin, remoteMax int) (ok bool, localTooOld bool) {
	if remoteMin == 0 {
		remoteMin = 1
	}
	if remoteMax == 0 {
		remoteMax = 1
	}
	lo := localMin
	if remoteMin > lo {
		lo = remoteMin
	}
	hi := localMax
	if remoteMax < hi {
		hi = remoteMax
	}
	if lo <= hi {
		return true, false
	}
	return false, remoteMin > localMax
}

// CompatErrorMessage returns the CLI's user-facing error string for an
// incompatible peer. localVer and remoteVer are human release strings (e.g.
// "v1.5.5"); either may be empty for legacy peers.
func CompatErrorMessage(localTooOld bool, localVer, remoteVer string, localMin, localMax, remoteMin, remoteMax int) string {
	return compatErrorMessage(localTooOld, localVer, remoteVer, localMin, localMax, remoteMin, remoteMax, "")
}

// compatErrorMessage lets GUI callers replace the CLI-only local update
// instruction. An empty updateHint preserves the CLI wording exactly.
func compatErrorMessage(localTooOld bool, localVer, remoteVer string, localMin, localMax, remoteMin, remoteMax int, updateHint string) string {
	localRange := fmt.Sprintf("protocol %d", localMin)
	if localMax != localMin {
		localRange = fmt.Sprintf("protocol %d-%d", localMin, localMax)
	}
	remoteRange := fmt.Sprintf("protocol %d", remoteMin)
	if remoteMax != remoteMin {
		remoteRange = fmt.Sprintf("protocol %d-%d", remoteMin, remoteMax)
	}
	if localVer != "" {
		localRange += " (" + localVer + ")"
	}
	if remoteVer != "" {
		remoteRange += " (" + remoteVer + ")"
	}
	if localTooOld {
		if updateHint == "" {
			updateHint = "Run `floe update` to upgrade."
		}
		return fmt.Sprintf(
			"Cannot transfer: your floe is too old for this peer.\n  You: %s  Peer: %s\n  %s",
			localRange, remoteRange, updateHint,
		)
	}
	if updateHint != "" {
		return fmt.Sprintf(
			"Cannot transfer: peer's floe is too old.\n  You: %s  Peer: %s\n  Ask the other side to update Floe.",
			localRange, remoteRange,
		)
	}
	return fmt.Sprintf(
		"Cannot transfer: peer's floe is too old.\n  You: %s  Peer: %s\n  Ask the other side to run `floe update`.",
		localRange, remoteRange,
	)
}

// peerCompatErrorMessage describes the same mismatch from the remote peer's
// perspective. It is sent on the wire as a surface-neutral fallback for peers
// that display Reason verbatim instead of rebuilding it from pv/pvMin.
func peerCompatErrorMessage(localTooOld bool, localVer, remoteVer string, localMin, localMax, remoteMin, remoteMax int) string {
	return compatErrorMessage(!localTooOld, remoteVer, localVer,
		remoteMin, remoteMax, localMin, localMax, "Update Floe to continue.")
}

// compatErrorFromIncompatible rebuilds current peers' error messages from the
// local caller's perspective. Older peers only supplied Reason, so retain it as
// the compatibility fallback.
func compatErrorFromIncompatible(localVer, updateHint string, incompat incompatibleMsg) string {
	if ok, localTooOld := CheckCompat(MinProtocolVersion, ProtocolVersion, incompat.PvMin, incompat.Pv); !ok {
		return compatErrorMessage(localTooOld, localVer, incompat.Ver,
			MinProtocolVersion, ProtocolVersion, incompat.PvMin, incompat.Pv, updateHint)
	}
	if incompat.Reason != "" {
		return incompat.Reason
	}
	return "peer rejected transfer: protocol incompatible"
}
