package main

// The request drop's bound on a visitor that vanished (G5-F1), which Send
// shares for a receiver that vanished after the last byte (FT-GO-CONFIRMS
// step 2). Kept in its own file, out of the request clocks' var block in
// transfer.go and out of the engine's receive, so it touches runRequestDrop
// and runSend at one line each.

import "github.com/jannskiee/floe/cli/engine/peer"

// requestConnFailed is the connection's peer.Connection.Failed, a package var
// only so a test can fire the failure without waiting out ICE.
var requestConnFailed = func(c *peer.Connection) <-chan struct{} { return c.Failed() }

// watchConnFailed closes conn when ICE gives up on its path, until quit.
//
// A visitor whose tab was closed, crashed or discarded, or whose network went
// away, sends no close this side can hear, and while a drop runs the lane
// reads neither signaling nor any connection state (spec 06 4.17). So the
// receive's 60 s stall watchdog, or while the owner decides the whole answer
// window, was the only way out. Failed comes about 30 s after the last packet
// from the visitor and is terminal. Closing the connection then ends the drop
// the way a close always has: an accepted drop stops with the ST14 code
// (unknown), and a prompt ends as the visitor leaving. A blackout that
// recovers passes through disconnected only and never gets here (E-84).
//
// runSend watches the same way: a Go receiver's ack promises its word after
// the last file (confirms), and the engine's wait for it has no deadline of
// its own, so the close ends it with ErrClosedBeforeReceived, which errors.ts
// shows as the lost-connection line.
//
// The seam is read here, on the caller's goroutine, and the watch runs on its
// own, which returns on quit.
func watchConnFailed(conn *peer.Connection, quit <-chan struct{}) {
	failed := requestConnFailed(conn)
	go func() {
		select {
		case <-failed:
			conn.Close()
		case <-quit:
		}
	}()
}
