package main

// The one-transfer-at-a-time state machine: which generation is live, what it
// owns that must be closed, and whether a close request may proceed.

import (
	"context"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// beginTransfer claims the transfer slots for a new attempt and returns its
// generation tag. Any previous attempt is superseded from this moment: its
// setters, clear, wake release, emits, and toasts all become no-ops. The old
// goroutine's own defers still close the handles it holds.
func (a *App) beginTransfer() uint64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.gen++
	a.cancelled = false
	a.busy = true
	a.curSC, a.curConn = nil, nil
	return a.gen
}

// setSignaling / setConn register a handle for generation g so CancelTransfer
// can reach it. They return false when g no longer owns the slots (superseded
// by a newer transfer) or was cancelled; the caller must bail out immediately
// and let its own deferred Close release the handle. Refusing on cancelled
// also closes the window where a cancel lands between the two setters and the
// goroutine would otherwise park un-interruptibly in WebRTC setup for up to
// 30 seconds holding an orphaned connection.
func (a *App) setSignaling(g uint64, sc closer) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if g != a.gen || a.cancelled {
		return false
	}
	a.curSC = sc
	return true
}

func (a *App) setConn(g uint64, conn closer) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if g != a.gen || a.cancelled {
		return false
	}
	a.curConn = conn
	return true
}

// clearTransfer releases the slots iff generation g still owns them, so a
// superseded goroutine's deferred clear cannot wipe a live transfer's handles.
func (a *App) clearTransfer(g uint64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if g != a.gen {
		return
	}
	a.curSC, a.curConn = nil, nil
	// Behind the gen guard on purpose: a superseded goroutine's stale
	// deferred clear must not un-guard the live transfer's close prompt.
	a.busy = false
}

// transferActive reports whether generation g is still the live, uncancelled
// transfer. It gates event emits and toasts so a cancelled or superseded
// attempt goes silent instead of talking over its successor.
func (a *App) transferActive(g uint64) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return g == a.gen && !a.cancelled
}

// CancelTransfer aborts the current send or receive: it marks the owning
// generation cancelled (suppressing its failure toast and late events) and
// closes its signaling and peer connections. Closing the signaling client
// unblocks a sender waiting for a receiver (via PeerLeft); closing the peer
// connection unblocks a stuck WebRTC setup (via the connection-state error).
// Safe to call when nothing is running.
//
// Ordering contract: it cancels whatever attempt is live when it EXECUTES, so
// a caller must not dispatch a new StartSend/ReceiveByCode until this call has
// been issued and processed; two unawaited bridge calls fired in the same tick
// have no cross-call ordering guarantee, and a reordered pair would cancel the
// new attempt instead of the old one. The UI satisfies this trivially (the
// user's next click is far behind the cancel dispatch); programmatic drivers
// must await CancelTransfer before starting the next transfer.
func (a *App) CancelTransfer() {
	a.mu.Lock()
	a.cancelled = true
	sc, conn := a.curSC, a.curConn
	a.mu.Unlock()
	if conn != nil {
		conn.Close()
	}
	if sc != nil {
		sc.Close()
	}
}

// closeBlocked reports whether quitting must be intercepted: a live,
// uncancelled transfer is in flight and the user has not yet said
// "Close anyway". Pure state, testable on a bare &App{}.
func (a *App) closeBlocked() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.busy && !a.cancelled && !a.allowClose
}

// onBeforeClose is the Wails close hook, covering every close path (the
// custom titlebar X, Alt+F4, the taskbar's Close). It MUST return
// immediately: on a real WM_CLOSE it runs inline on the Windows message-pump
// thread, so blocking here freezes the window. No dialog from Go, therefore;
// just tell the frontend to ask. EventsEmit posts and returns, never blocks.
// Returning false whenever no transfer is active is the property that makes
// an unclosable window impossible.
func (a *App) onBeforeClose(ctx context.Context) bool {
	if !a.closeBlocked() {
		return false
	}
	runtime.EventsEmit(ctx, "close:blocked")
	return true
}

// ConfirmClose is the "Close anyway" button. The latch comes first,
// unconditionally: even a wedged cancel after this line can never leave the
// window unclosable, because the re-entered onBeforeClose now returns false.
// Then abort the transfer (closes both connections synchronously, so the
// peer sees the drop rather than a silent stall; cancelled also suppresses
// the failure toast, since a user-ordered close is not a failure) and quit.
// Deliberately no wait for the transfer goroutine's cleanup: a leftover
// .part staging file is the accepted cost of an instant close, and the
// shutdown hook tidies it.
func (a *App) ConfirmClose() {
	a.mu.Lock()
	a.allowClose = true
	a.mu.Unlock()
	a.CancelTransfer()
	if a.quitFn != nil {
		a.quitFn()
		return
	}
	runtime.Quit(a.ctx)
}
