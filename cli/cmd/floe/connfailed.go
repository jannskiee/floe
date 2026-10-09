package main

// floe send's bound on a receiver that vanished (FT-GO-CONFIRMS step 2). A Go
// receiver's ack now promises a final word, and the sender's wait for it has
// no deadline of its own, so this is what ends it when the word can never
// come.

import "github.com/jannskiee/floe/cli/engine/peer"

// connFailed is the connection's peer.Connection.Failed, a package var only so
// a test can stand in for it.
var connFailed = func(c *peer.Connection) <-chan struct{} { return c.Failed() }

// closeOnFailed closes conn when ICE gives up on its path, until quit.
//
// A receiver whose machine crashed or whose network went away sends no close
// this side can hear, and after the last byte a send to a receiver that
// promised its word (the ack's confirms) waits for "received" or a refusal
// with nothing left in the buffer to stall on. Failed comes about 30 s after
// the last packet from the receiver and is terminal; closing the connection
// then ends the send with ErrClosedBeforeReceived, never a success. A
// blackout that recovers passes through disconnected only and never gets
// here. The seam is read on the caller's goroutine; the watch runs on its own
// and returns on quit.
func closeOnFailed(conn *peer.Connection, quit <-chan struct{}) {
	failed := connFailed(conn)
	go func() {
		select {
		case <-failed:
			conn.Close()
		case <-quit:
		}
	}()
}
