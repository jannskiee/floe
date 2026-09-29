package peer

import "github.com/pion/webrtc/v4"

// PeerConnectionForTest hands this package's external tests the pion
// connection under a Connection, so one side of a pairing can act as a peer no
// Floe release is (it opens a data channel of its own). Test builds only.
func (conn *Connection) PeerConnectionForTest() *webrtc.PeerConnection { return conn.pc }
