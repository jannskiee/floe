package main

// The Request link lane (spec 06 4): the link's own slot, with its own mutex
// and generation, so an open link never blocks Send or code Receive and
// neither of them can supersede it, silence it or close it. The transfer
// slot's generation, busy flag and handles (transferstate.go) are never read
// or written from here, and the lane's generations count on their own.
//
// Locking rule: a.mu and l.mu are never held together. A function that needs
// both reads one, releases it, then takes the other; network and disk I/O
// never run under l.mu. The close guard reads l.live, an atomic, and never
// waits on l.mu (S1-DSK-04).
//
// Privacy: the host token, the link, the link id and the room id live in this
// struct only, in memory. The link reaches the screen through the snapshot's
// Link field and nothing else; the token reaches nothing but the one join
// frame the engine writes. None of them is logged, persisted or put in an
// error. Every snapshot code is a key the frontend maps to fixed copy.
//
// SetRequestLinks lives in endpoints.go and RequestLinkSupport in
// serverprobe.go, with their concerns (S1-DSK-02).

import (
	"math/rand/v2"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/jannskiee/floe/cli/engine/ice"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// RequestLinkSnapshot is the whole host-authoritative lane state, sent on the
// request:state event and returned by the lane methods (spec 06 4.4). Codes are
// keys the frontend maps to fixed copy (requestCopy.ts); no field ever holds
// engine error text, the host token, or a visitor-chosen string. Times are
// unix milliseconds.
type RequestLinkSnapshot struct {
	// State is one of off, ready, making, error, waiting, reconnecting,
	// connecting, deciding, declined, receiving, done, stopped, ended.
	State string `json:"state"`
	// Code is the refusal, stop or end code for error, stopped, ended and a
	// reopened waiting; "" when none.
	Code string `json:"code"`
	// Gen is the lane generation; the frontend ignores a snapshot whose Gen is
	// lower than the last one it adopted.
	Gen uint64 `json:"gen"`
	// Seq orders snapshots within and across generations (D-115): a
	// per-process counter the lane increments for every snapshot it emits on
	// request:state or returns from a bound method, stamped under the lane
	// lock. (Gen, Seq) is a total order, and the frontend never adopts a
	// snapshot older than the last one it adopted, so a binding's reply that
	// loses the race to a later event (an AnswerRequest reply that still says
	// deciding after receiving was emitted) cannot bring an old state back.
	Seq uint64 `json:"seq"`
	// PromptGen identifies the prompt an AnswerRequest answers.
	PromptGen uint64 `json:"promptGen"`
	// Link is web + "/r/" + linkId + "#" + roomId; "" until waiting. It lives
	// in memory and on screen only, never in a file or a log.
	Link string `json:"link"`
	// Label is the owner's own label, which never leaves this PC.
	Label   string `json:"label"`
	SaveDir string `json:"saveDir"`
	// ExpiresAt is when the link ends.
	ExpiresAt int64 `json:"expiresAt"`
	// Route is "", "direct" or "relay".
	Route string `json:"route"`
	// ReconnectUntil is set while reconnecting: the lane retries until the
	// link's own end time (E-34).
	ReconnectUntil int64 `json:"reconnectUntil,omitempty"`
	// MissedAt is when the last request timed out unanswered (W10).
	MissedAt int64 `json:"missedAt,omitempty"`
	// SuggestClose is set after two prompts on this link ended without Accept
	// within 10 minutes (E-40, W13).
	SuggestClose bool `json:"suggestClose"`
	// Prompt is present only while deciding.
	Prompt *RequestPrompt `json:"prompt,omitempty"`
	// Result is present once a drop was accepted: done, or stopped after
	// Accept.
	Result *RequestResult `json:"result,omitempty"`
}

// RequestPrompt is what the Accept prompt shows: numbers and host-computed
// values only. It never carries IncomingInfo.FirstName or any other visitor
// string (OD-04, Q-C7).
type RequestPrompt struct {
	Files      int   `json:"files"`      // the visitor's claimed count (a number)
	TotalBytes int64 `json:"totalBytes"` // the visitor's claimed total (a number)
	// Folder is the host-computed destination, for example
	// Floe requests\Acme footage 2026-09-14 1405.
	Folder    string `json:"folder"`
	FreeBytes int64  `json:"freeBytes"` // free space on the save volume
	// Warnings are codes, never text: low-space, file-too-large-for-drive,
	// relay-over-cap, laptop-power.
	Warnings []string `json:"warnings"`
	AnswerBy int64    `json:"answerBy"`
}

// RequestResult is the outcome of an accepted drop. Names are the engine's
// display-safe saved names, at most 200 of them; Files keeps the real count.
type RequestResult struct {
	Files    int      `json:"files"`    // files the visitor offered
	Saved    int      `json:"saved"`    // files committed to disk
	Bytes    int64    `json:"bytes"`    // bytes committed to disk
	Verified int      `json:"verified"` // files whose SHA-256 matched
	Renamed  int      `json:"renamed"`  // files renamed to .floe-blocked
	Folder   string   `json:"folder"`   // the absolute exclusive subfolder
	Names    []string `json:"names"`
}

// The lane's timings. Liveness is the engine's own ping and read deadline
// (spec 06 4.17); the backoff floor keeps a flapping host inside the server's
// 30-connections-a-minute budget (Checkpoint A risk 9).
const (
	requestPing         = 25 * time.Second
	requestReadDeadline = 60 * time.Second
	requestBackoffBase  = time.Second
	requestBackoffCap   = 30 * time.Second
	// requestStableAfter is how long a re-joined socket must stay up before
	// the backoff starts again from its floor: a socket that dies at once keeps
	// the backoff growing instead of reconnecting every second.
	requestStableAfter = requestReadDeadline
	// requestCloseWait bounds the wait for the best-effort request-close write
	// when the owner closes a link.
	requestCloseWait = 2 * time.Second
	// requestLabelMax caps the owner's label, on screen and in the folder name.
	requestLabelMax = 64
)

// requestDefaultDirFn is the default save folder for a link made without
// one, Downloads\Floe requests; a package var so a test can stall it.
var requestDefaultDirFn = func() string {
	return filepath.Join(defaultReceiveDir(), "Floe requests")
}

// joinWithTokenFn is the host join, a package var so tests can return any
// result at once instead of waiting out the client's own 10 s reply timeout.
// The lane arms no join timer of its own (M-04).
var joinWithTokenFn = (*signaling.Client).JoinRoomWithToken

// reqAnswer is one owner answer to one prompt, for the Decide callback.
type reqAnswer struct {
	promptGen uint64
	answer    string // accept or decline
}

// requestLane is the Request link's own slot (spec 06 4.2). It never shares
// the transfer slot's generation, busy flag or handles.
type requestLane struct {
	mu sync.Mutex
	// gen is the lane generation: bumped by every Make link, Close link and
	// quit. A lane goroutine carries the gen it was born with; every state
	// change and emit it makes refuses once gen has moved on or cancelled is
	// set (requestActive).
	gen       uint64
	cancelled bool   // the owning generation was ended by the owner or a quit
	state     string // "" reads as off
	code      string
	// seq stamps every snapshot the lane builds, emitted or returned, so
	// (gen, seq) totally orders them (D-115). One lane per process, so this
	// is the per-process counter; only ever read and bumped under mu.
	seq uint64

	// The link's secrets, in memory only; endLocked forgets them. hostToken
	// is kept for the lane's shape (spec 06 4.2) but nothing reads it: the
	// lane goroutine joins with its own copy. Never print the lane (a %v of
	// it would show the token) and never copy the field into a snapshot
	// (TestRequestSnapshotNeverCarriesToken).
	roomID    string
	linkID    string
	hostToken string
	link      string

	label     string // display label: trimmed, at most requestLabelMax runes
	saveDir   string
	expiresAt time.Time
	server    string
	web       string
	hideIP    bool

	sc   *signaling.Client // the host /ws socket while a link is open
	conn closer            // the peer connection while connecting..receiving

	promptGen      uint64
	decision       chan reqAnswer // buffered 1; the Decide callback reads it
	route          string
	reconnectUntil time.Time
	missedAt       time.Time
	suggestClose   bool
	prompt         *RequestPrompt
	result         *RequestResult
	dropCancel     func() // set while a drop runs (S1-DSK-03b)
	ownerStop      bool   // the owner's own Cancel drop ended it: no failure toast

	// Attention (S1-DSK-05): whether the flash and the "(1) Floe" title are
	// on, and when prompts on this link ended without Accept (E-40).
	// attentionSeq counts attention changes, so applyAttention can tell when
	// another change came in while it applied one.
	attention    bool
	attentionSeq uint64
	promptEnds   []time.Time

	stop  chan struct{} // closed when this link's generation ends
	retry chan struct{} // buffered 1; Retry now

	// live mirrors liveState(state) for readers that must not take mu: the
	// close guard runs on the Windows message-pump thread.
	live atomic.Bool

	// pairFn is the pairing body, run on user-connected by the goroutine that
	// owns sc: runRequestDrop (S1-DSK-03b), through pairRequest. Its contract:
	// it returns with the lane in waiting, declined, done or stopped (or rg
	// gone); it registers its peer connection with setRequestConn and clears
	// it before returning; and for every acceptDrop that returned true it
	// releases the wake hold, even when rg has moved on: through endDrop, or
	// with requestWakeRelease for an Accept the engine found abandoned before
	// any claim.
	pairFn func(rg uint64, sc *signaling.Client)

	// emitMu serializes building and emitting snapshots, so two emits can
	// never reach the frontend in the opposite order to the state changes.
	emitMu sync.Mutex

	// app is the App the lane belongs to: closeForQuit releases the wake
	// hold through it.
	app *App

	// Seams, fixed at construction. Tests replace them on a fresh lane
	// before any goroutine starts.
	emitFn       func(event string, data any)
	closeFrameFn func(sc *signaling.Client) error // the request-close write
	setTitleFn   func(title string)               // nil: runtime.WindowSetTitle
	flashFn      func(on bool)                    // nil: flashTaskbar / stopFlash
	now          func() time.Time                 // the E-40 clock
	supportFn    func(server string) FeatureResult
	relayFn      func(server string) (hasRelay, degraded bool, err error)
	lifetimeFn   func(lifetime string) (time.Duration, bool)
	backoffBase  time.Duration
	backoffCap   time.Duration
	closeWait    time.Duration

	wg sync.WaitGroup // lane goroutines, so tests can wait them out
}

// newRequestLane builds the lane for a, wired to the real probe, ICE fetch
// and emit.
func newRequestLane(a *App) *requestLane {
	l := &requestLane{
		app:          a,
		closeFrameFn: (*signaling.Client).RequestClose,
		now:          time.Now,
		decision:     make(chan reqAnswer, 1),
		supportFn:    requestLinkSupport,
		relayFn:      fetchRelay,
		lifetimeFn:   requestLifetime,
		backoffBase:  requestBackoffBase,
		backoffCap:   requestBackoffCap,
		closeWait:    requestCloseWait,
	}
	l.pairFn = func(rg uint64, sc *signaling.Client) { a.pairRequest(rg, sc) }
	return l
}

// lane returns a's request lane, creating it on first use so a bare &App{}
// in a test works like NewApp's.
func (a *App) lane() *requestLane {
	a.reqOnce.Do(func() {
		if a.req == nil {
			a.req = newRequestLane(a)
		}
	})
	return a.req
}

// fetchRelay is the one-off relay probe for Hide my IP at Make link: the list
// is read for HasRelay and then dropped, never reused at pairing (L13).
func fetchRelay(server string) (hasRelay, degraded bool, err error) {
	list, degraded, err := ice.FetchDetail(server)
	return ice.HasRelay(list), degraded, err
}

// requestLifetime maps the lifetime key to a duration: "24h" (the default,
// also for "") or "7d" (OD-08). Anything else is refused.
func requestLifetime(lifetime string) (time.Duration, bool) {
	switch lifetime {
	case "", "24h":
		return 24 * time.Hour, true
	case "7d":
		return 7 * 24 * time.Hour, true
	}
	return 0, false
}

// liveState reports whether state means a link is being made, is open, or a
// drop runs: the states the one-link rule and the close guard count.
func liveState(state string) bool {
	switch state {
	case "making", "waiting", "reconnecting", "connecting", "deciding", "declined", "receiving":
		return true
	}
	return false
}

// liveNow reports whether a link is being made, is open, or a drop runs. It
// reads the atomic only and never takes the lane mutex, so a caller holding
// a.mu (SetRequestLinks) or running on the Windows message-pump thread (the
// close guard) can never wait on the lane. Nil-safe.
func (l *requestLane) liveNow() bool {
	return l != nil && l.live.Load()
}

// setStateLocked moves the lane to state with code and keeps live in step.
func (l *requestLane) setStateLocked(state, code string) {
	l.state, l.code = state, code
	l.live.Store(liveState(state))
}

// endLocked moves the lane to a terminal state and forgets the link's
// secrets: the token dies with the link.
func (l *requestLane) endLocked(state, code string) {
	l.setStateLocked(state, code)
	l.hostToken, l.roomID, l.linkID, l.link = "", "", "", ""
	l.prompt = nil
	l.reconnectUntil = time.Time{}
	// A link that ended needs no goroutine: wake it, so it lets go of its
	// socket instead of waiting on it until the link's old end time.
	l.stopLocked()
}

// stopLocked closes the current link's stop channel once.
func (l *requestLane) stopLocked() {
	if l.stop != nil {
		close(l.stop)
		l.stop = nil
	}
}

// detachLocked ends the owning generation (bump and cancel), wakes its
// goroutine and hands back the handles for the caller to close outside mu.
func (l *requestLane) detachLocked() (sc *signaling.Client, conn closer) {
	l.gen++
	l.cancelled = true
	l.stopLocked()
	sc, conn = l.sc, l.conn
	l.sc, l.conn = nil, nil
	l.dropCancel = nil
	return sc, conn
}

// snapshotLocked copies the lane into the bound shape and stamps it with the
// next seq. Every snapshot that leaves the lane, on request:state or as a
// bound method's return, is built here, so none escapes unstamped. Slices are
// copied so a later change never reaches a snapshot already handed out.
func (l *requestLane) snapshotLocked() RequestLinkSnapshot {
	state := l.state
	if state == "" {
		state = "off"
	}
	l.seq++
	s := RequestLinkSnapshot{
		State:        state,
		Code:         l.code,
		Gen:          l.gen,
		Seq:          l.seq,
		PromptGen:    l.promptGen,
		Link:         l.link,
		Label:        l.label,
		SaveDir:      l.saveDir,
		Route:        l.route,
		SuggestClose: l.suggestClose,
	}
	if !l.expiresAt.IsZero() {
		s.ExpiresAt = l.expiresAt.UnixMilli()
	}
	if state == "reconnecting" && !l.reconnectUntil.IsZero() {
		s.ReconnectUntil = l.reconnectUntil.UnixMilli()
	}
	if !l.missedAt.IsZero() {
		s.MissedAt = l.missedAt.UnixMilli()
	}
	if state == "deciding" && l.prompt != nil {
		p := *l.prompt
		p.Warnings = append([]string{}, l.prompt.Warnings...)
		s.Prompt = &p
	}
	if l.result != nil {
		r := *l.result
		r.Names = append([]string{}, l.result.Names...)
		s.Result = &r
	}
	return s
}

// requestActive reports whether lane generation rg is still the live,
// uncancelled one. It gates every state change, emit and toast a lane
// goroutine makes.
func (a *App) requestActive(rg uint64) bool {
	l := a.lane()
	l.mu.Lock()
	defer l.mu.Unlock()
	return rg == l.gen && !l.cancelled
}

// emitRequest sends one lane event to the frontend. Reads a.ctx under a.mu
// with l.mu NOT held; a bare test App without a context emits nothing.
func (a *App) emitRequest(event string, data any) {
	l := a.lane()
	if l.emitFn != nil {
		l.emitFn(event, data)
		return
	}
	a.mu.Lock()
	ctx := a.ctx
	a.mu.Unlock()
	if ctx == nil {
		return
	}
	runtime.EventsEmit(ctx, event, data)
}

// emitState emits request:state with the full snapshot, gated on
// requestActive(rg).
func (a *App) emitState(rg uint64) {
	l := a.lane()
	l.emitMu.Lock()
	defer l.emitMu.Unlock()
	l.mu.Lock()
	if rg != l.gen || l.cancelled {
		l.mu.Unlock()
		return
	}
	snap := l.snapshotLocked()
	l.mu.Unlock()
	a.emitRequest("request:state", snap)
}

// emitCurrent emits the current snapshot ungated: for the owner's own Close
// link, whose new generation is cancelled from birth.
func (a *App) emitCurrent() {
	l := a.lane()
	l.emitMu.Lock()
	defer l.emitMu.Unlock()
	l.mu.Lock()
	snap := l.snapshotLocked()
	l.mu.Unlock()
	a.emitRequest("request:state", snap)
}

// reqUpdate applies fn to the lane iff rg is still the live generation, then
// emits. False means rg was superseded or cancelled: the caller stops.
func (a *App) reqUpdate(rg uint64, fn func(l *requestLane)) bool {
	l := a.lane()
	l.mu.Lock()
	if rg != l.gen || l.cancelled {
		l.mu.Unlock()
		return false
	}
	fn(l)
	l.mu.Unlock()
	a.emitState(rg)
	return true
}

// reqFail ends generation rg in error with code.
func (a *App) reqFail(rg uint64, code string) {
	a.reqUpdate(rg, func(l *requestLane) { l.endLocked("error", code) })
}

// setRequestSignaling registers sc as generation rg's host socket so Close
// link and quit can reach it. False when rg no longer owns the lane: the
// caller closes sc itself.
func (a *App) setRequestSignaling(rg uint64, sc *signaling.Client) bool {
	l := a.lane()
	l.mu.Lock()
	defer l.mu.Unlock()
	if rg != l.gen || l.cancelled {
		return false
	}
	l.sc = sc
	return true
}

// releaseRequestSocket lets go of sc if the lane still holds it: forgets it,
// sends request-close best effort when sendClose, and closes it. A socket the
// lane no longer holds was taken by Close link, a quit or a new Make link,
// which end it themselves after their own request-close; closing it here too
// would race that write and drop it (the 20x stress caught that), so it is
// left alone.
func (a *App) releaseRequestSocket(sc *signaling.Client, sendClose bool) {
	if sc == nil {
		return
	}
	l := a.lane()
	l.mu.Lock()
	owned := l.sc == sc
	if owned {
		l.sc = nil
	}
	wait, closeFrame := l.closeWait, l.closeFrameFn
	l.mu.Unlock()
	if !owned {
		return
	}
	if sendClose {
		sendCloseWithin(sc, closeFrame, wait)
	}
	sc.Close()
}

// displayLabel is the owner's label as the snapshot carries it: trimmed and
// capped at requestLabelMax runes. It stays on this PC.
func displayLabel(label string) string {
	s := strings.TrimSpace(label)
	if utf8.RuneCountInString(s) > requestLabelMax {
		s = string([]rune(s)[:requestLabelMax])
	}
	return strings.TrimSpace(s)
}

// sanitizeRequestLabel turns the owner's label into one Windows-valid path
// component for the drop's subfolder (spec 06 4.7): the engine's
// single-component sanitizer (separators, controls, bidi marks, and on Windows
// the reserved characters, trailing dots and spaces, device names), then the
// rules that must hold on every OS: trailing dots and spaces trimmed, capped at
// requestLabelMax runes, a bare device name suffixed with "_", and "Request"
// when nothing is left.
func sanitizeRequestLabel(label string) string {
	s := transfer.SafeFolderName(strings.TrimSpace(label))
	s = strings.TrimRight(s, " .")
	if utf8.RuneCountInString(s) > requestLabelMax {
		s = string([]rune(s)[:requestLabelMax])
		s = strings.TrimRight(s, " .")
	}
	if isDeviceName(s) {
		s += "_"
	}
	if s == "" || s == "." || s == ".." {
		return "Request"
	}
	return s
}

// isDeviceName reports whether s is a Win32 device name, case-insensitively
// and as the whole name.
func isDeviceName(s string) bool {
	u := strings.ToUpper(s)
	switch u {
	case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$":
		return true
	}
	if len(u) == 4 && (strings.HasPrefix(u, "COM") || strings.HasPrefix(u, "LPT")) && u[3] >= '1' && u[3] <= '9' {
		return true
	}
	return false
}

// requestLinkFor builds the link: web + "/r/" + linkID + "#" + roomID. The room
// id rides in the fragment, which a browser never sends to a server; the link
// id names the page only and never reaches the signaling server.
func requestLinkFor(web, linkID, roomID string) string {
	return web + "/r/" + linkID + "#" + roomID
}

// webBaseUsable is the E-21 check: a link built on the signaling origin
// points at the API, not at a web app, so when web equals server the pair
// must be Floe's own server or a local one. A split self-host sets its Share
// link address under Settings, Advanced (E8).
func webBaseUsable(server, web string) bool {
	if web != server {
		return true
	}
	return server == defaultServer || isLocalOrigin(server)
}

// isLocalOrigin reports whether origin's host is this machine.
func isLocalOrigin(origin string) bool {
	rest := origin
	if i := strings.Index(rest, "://"); i >= 0 {
		rest = rest[i+3:]
	}
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		rest = rest[:i]
	}
	host := rest
	if strings.HasPrefix(host, "[") {
		if i := strings.IndexByte(host, ']'); i >= 0 {
			host = host[1:i]
		}
	} else if i := strings.LastIndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	switch strings.ToLower(host) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

// joinCode maps a host join result to the snapshot code (step 3g): only the
// two refusals the Beta names keep their own code; every other answer,
// including an unrecognized refusal code, is unknown (E-25, E-59).
func joinCode(res signaling.HostJoinResult) string {
	switch res {
	case signaling.HostRefusedDisabled:
		return "disabled"
	case signaling.HostRefusedLimited:
		return "limited"
	}
	return "unknown"
}

// reconnectDelay is the full-jitter backoff for reconnect attempt n (0-based):
// uniform between base and min(cap, base * 2^n), so never below base.
func reconnectDelay(n int, base, cap time.Duration, r func(int64) int64) time.Duration {
	top := base
	for i := 0; i < n && top < cap; i++ {
		top *= 2
	}
	if top > cap {
		top = cap
	}
	if top <= base {
		return base
	}
	return base + time.Duration(r(int64(top-base)+1))
}

// MakeRequestLink makes one request link (spec 06 4.3) and returns at once
// with the current snapshot; the frontend follows request:state. The switch
// and the one-link rule are checked here; the probe, the relay check and the
// host join run on the lane goroutine.
func (a *App) MakeRequestLink(label string, saveDir string, lifetime string) RequestLinkSnapshot {
	a.mu.Lock()
	on := a.cfg.RequestLinks
	hideIP := a.cfg.HideIP
	a.mu.Unlock()

	// The default save folder touches the disk (a home lookup and an os.Stat
	// of Downloads, which a slow or offline redirected folder can stall), so
	// it is worked out before the lane lock (review 1a F5).
	saveDir = strings.TrimSpace(saveDir)
	if saveDir == "" {
		saveDir = requestDefaultDirFn()
	}

	l := a.lane()
	l.mu.Lock()
	if l.live.Load() {
		// One link in the Beta (OD-05). The live link is left exactly as it
		// is, and the refusal carries gen 0 so a frontend already following
		// the live link never adopts it over that link. It still takes a seq.
		l.seq++
		refusal := RequestLinkSnapshot{State: "error", Code: "already-open", Seq: l.seq}
		l.mu.Unlock()
		return refusal
	}
	// A socket an ended link's goroutine has not let go of yet is taken here
	// and torn down below, so the new link's registration can never orphan
	// it (finishRequestSocket leaves a socket it no longer owns alone).
	leftover := l.sc
	l.sc = nil
	// The same for a peer connection and a drop cancel an ended drop did not
	// clear: the connection is closed with the socket, and the cancel, which
	// belongs to a drop that is over, is dropped unrun (review 1a N4).
	leftConn := l.conn
	l.conn, l.dropCancel = nil, nil
	leftWait, leftClose := l.closeWait, l.closeFrameFn
	l.gen++
	rg := l.gen
	l.cancelled = false
	l.endLocked("", "")
	l.expiresAt = time.Time{}
	l.route, l.result, l.missedAt, l.suggestClose = "", nil, time.Time{}, false
	l.promptEnds, l.ownerStop = nil, false
	l.label = displayLabel(label)
	l.saveDir = saveDir
	if leftover != nil || leftConn != nil {
		l.wg.Add(1)
		go func() {
			defer l.wg.Done()
			requestTeardown(leftover, leftConn, leftWait, leftClose)
		}()
	}
	if !on {
		l.setStateLocked("error", "off")
		snap := l.snapshotLocked()
		l.mu.Unlock()
		a.emitState(rg)
		return snap
	}
	l.setStateLocked("making", "")
	l.stop = make(chan struct{})
	l.retry = make(chan struct{}, 1)
	stop := l.stop
	snap := l.snapshotLocked()
	l.wg.Add(1)
	l.mu.Unlock()
	a.emitState(rg)
	go func() {
		defer l.wg.Done()
		a.runRequestLink(rg, stop, hideIP, lifetime)
	}()
	return snap
}

// runRequestLink is the lane goroutine of generation rg: the checks, the host
// join, then the waiting loop and its reconnects until the link ends.
func (a *App) runRequestLink(rg uint64, stop <-chan struct{}, hideIP bool, lifetime string) {
	l := a.lane()

	// One endpoints snapshot for the probe, the relay check and every join of
	// this link: a Settings change cannot move a live link to another server.
	server, web := a.endpoints()

	// c: the server must list request-1 right now (E-59).
	fr := l.supportFn(server)
	if !a.requestActive(rg) {
		return
	}
	if !fr.Reachable {
		a.reqFail(rg, "unknown")
		return
	}
	if !fr.RequestLinks {
		a.reqFail(rg, "disabled")
		return
	}
	// d: a link must point at a web app (E-21).
	if !webBaseUsable(server, web) {
		a.reqFail(rg, "web-address")
		return
	}
	// e: Hide my IP needs a relay; the list is read once and dropped (L13).
	if hideIP {
		hasRelay, degraded, err := l.relayFn(server)
		if !a.requestActive(rg) {
			return
		}
		switch {
		case err != nil:
			a.reqFail(rg, "relay-unknown")
			return
		case requireRelay(true, hasRelay, degraded) == errRelayUnknown:
			a.reqFail(rg, "relay-unknown")
			return
		case requireRelay(true, hasRelay, degraded) == errNoRelay:
			a.reqFail(rg, "no-relay")
			return
		}
	}
	// f: the token, the derived room id and the link id, all from the engine
	// (L-06), in memory only.
	life, ok := l.lifetimeFn(lifetime)
	if !ok {
		a.reqFail(rg, "unknown")
		return
	}
	hostToken, err := signaling.NewHostToken()
	if err != nil {
		a.reqFail(rg, "unknown")
		return
	}
	roomID := signaling.RoomIDFromToken(hostToken)
	linkID, err := signaling.NewLinkID()
	if err != nil || roomID == "" {
		a.reqFail(rg, "unknown")
		return
	}
	expiresAt := time.Now().Add(life)
	if !a.reqUpdate(rg, func(l *requestLane) {
		l.hostToken, l.roomID, l.linkID = hostToken, roomID, linkID
		l.server, l.web, l.hideIP = server, web, hideIP
		l.expiresAt = expiresAt
	}) {
		return
	}

	// g: the host join.
	sc, res := a.hostJoin(rg, server, roomID, hostToken)
	if sc == nil && res == 0 {
		return // superseded while connecting
	}
	if res != signaling.HostJoined {
		if sc != nil {
			a.releaseRequestSocket(sc, false)
		}
		a.reqFail(rg, joinCode(res))
		return
	}
	link := requestLinkFor(web, linkID, roomID)
	if !a.reqUpdate(rg, func(l *requestLane) {
		l.link = link
		l.setStateLocked("waiting", "")
	}) {
		a.releaseRequestSocket(sc, false)
		return
	}

	attempt := 0
	joinedAt := time.Now()
	for {
		switch a.waitRequest(rg, stop, sc, expiresAt) {
		case waitEnded:
			a.finishRequestSocket(sc)
			return
		case waitDown:
			a.releaseRequestSocket(sc, false)
			if time.Since(joinedAt) >= requestStableAfter {
				attempt = 0
			}
			sc, attempt = a.reconnect(rg, stop, server, roomID, hostToken, expiresAt, attempt)
			if sc == nil {
				return
			}
			joinedAt = time.Now()
		}
	}
}

// hostJoin connects with liveness, makes the token join, then registers the
// socket with the lane. A nil sc with result 0 means rg was superseded; a nil
// sc with HostDown means the connect itself failed.
//
// The socket is registered only once its join has returned, so until then
// this goroutine alone touches it. Registered first, a Close link or a quit
// during the join would write request-close while the join was still writing
// the engine's room id: a data race, and a close frame naming no room that
// leaves the reservation the join then takes for its grace (review 1a F4).
func (a *App) hostJoin(rg uint64, server, roomID, hostToken string) (*signaling.Client, signaling.HostJoinResult) {
	sc, err := signaling.Connect(server, signaling.WithLiveness(requestPing, requestReadDeadline))
	if err != nil {
		if !a.requestActive(rg) {
			return nil, 0
		}
		return nil, signaling.HostDown
	}
	if !a.requestActive(rg) {
		sc.Close()
		return nil, 0
	}
	res, _ := joinWithTokenFn(sc, roomID, hostToken)
	if !a.setRequestSignaling(rg, sc) {
		// rg ended during the join, which left the socket to this goroutine:
		// free the reservation the join may have taken, then close it.
		if res == signaling.HostJoined {
			l := a.lane()
			l.mu.Lock()
			wait, closeFrame := l.closeWait, l.closeFrameFn
			l.mu.Unlock()
			sendCloseWithin(sc, closeFrame, wait)
		}
		sc.Close()
		return nil, 0
	}
	return sc, res
}

type waitResult int

const (
	waitEnded waitResult = iota // the link ended, or rg was superseded
	waitDown                    // the socket is gone: reconnect
)

// waitRequest is the waiting loop: the goroutine that owns sc reads it until
// a visitor arrives (pairFn), the socket goes, the server turns request links
// off, the link's time runs out, or rg ends.
func (a *App) waitRequest(rg uint64, stop <-chan struct{}, sc *signaling.Client, expiresAt time.Time) waitResult {
	l := a.lane()
	expiry := time.NewTimer(time.Until(expiresAt))
	defer expiry.Stop()
	for {
		select {
		case <-stop:
			return waitEnded
		case <-expiry.C:
			a.expireRequest(rg, sc)
			return waitEnded
		case <-sc.PeerConnected:
			l.pairFn(rg, sc)
			if !a.requestActive(rg) || !a.requestWaiting(rg) {
				return waitEnded
			}
		case code := <-sc.Refused:
			// A seated host hears refused only when its reservation was
			// deleted under it: disabled when the server turned request links
			// off (T24), anything else is unknown. Either way nothing retries.
			c := "unknown"
			if code == "disabled" {
				c = "disabled"
			}
			a.releaseRequestSocket(sc, false)
			a.reqFail(rg, c)
			return waitEnded
		case <-sc.Down:
			return waitDown
		case <-sc.PeerLeft:
			// Down closes before the read loop's own PeerLeft push, so an
			// open Down means the server reported the visitor gone. Before any
			// data channel exists that visitor may come back on a new socket,
			// and a room the server sealed once both seats signaled (D-116)
			// would answer it room-full: reopen it, and keep the link waiting.
			// Only in waiting: a visitor leaving a declined link is the
			// declined one going, and only the owner's Keep waiting reopens
			// that room (T17). Not when a user-connected is already waiting:
			// then this leave is the previous visitor's, a reopen would evict
			// the new one with room-full, and the next pass hands them to
			// pairFn, which drains the stale leave (review 1a N3, 1b N5). A
			// PeerLeft that follows Down is the Down case's to decide.
			select {
			case <-sc.Down:
			default:
				if len(sc.PeerConnected) == 0 && a.requestInState(rg, "waiting") {
					_ = sc.RequestReopen()
				}
			}
		}
	}
}

// finishRequestSocket lets go of the lane goroutine's socket when its link
// has ended. A socket still registered with the lane is the goroutine's to
// end: request-close best effort (a used-up or ended link frees its
// reservation now), then closed. One that Close link, a quit or a new Make
// link already took is theirs, and it is left alone: closing it here would
// race their request-close write and drop it (the 20x stress caught that).
func (a *App) finishRequestSocket(sc *signaling.Client) {
	a.releaseRequestSocket(sc, true)
}

// requestInState reports whether generation rg still owns the lane and the
// lane is in state.
func (a *App) requestInState(rg uint64, state string) bool {
	l := a.lane()
	l.mu.Lock()
	defer l.mu.Unlock()
	return rg == l.gen && !l.cancelled && l.state == state
}

// requestWaiting reports whether rg's lane still has a link that waits for a
// visitor (after a pairing attempt returned).
func (a *App) requestWaiting(rg uint64) bool {
	l := a.lane()
	l.mu.Lock()
	defer l.mu.Unlock()
	return rg == l.gen && liveState(l.state)
}

// expireRequest ends the link at its end time: ended expired, then
// request-close best effort and the socket closed.
func (a *App) expireRequest(rg uint64, sc *signaling.Client) {
	if !a.reqUpdate(rg, func(l *requestLane) { l.endLocked("ended", "expired") }) {
		return
	}
	a.releaseRequestSocket(sc, true)
}

// reconnect retries the connect and the token join with full-jitter backoff
// until the link's own end time (E-34). A re-join after a server restart
// re-creates the reservation silently (E-06). The state the socket loss
// interrupted comes back after the re-join: a declined link stays declined,
// because the server kept its room sealed (spec 04 5.7) and only the owner's
// Keep waiting reopens it (T17); anything else waits again. It returns the
// new socket, or nil when the link ended.
func (a *App) reconnect(rg uint64, stop <-chan struct{}, server, roomID, hostToken string, expiresAt time.Time, attempt int) (*signaling.Client, int) {
	l := a.lane()
	back, backCode := "waiting", ""
	if !a.reqUpdate(rg, func(l *requestLane) {
		if l.state == "declined" {
			back, backCode = l.state, l.code
		}
		l.setStateLocked("reconnecting", "")
		l.reconnectUntil = l.expiresAt
	}) {
		return nil, attempt
	}
	l.mu.Lock()
	retry := l.retry
	l.mu.Unlock()
	for {
		left := time.Until(expiresAt)
		if left <= 0 {
			a.reqUpdate(rg, func(l *requestLane) { l.endLocked("ended", "expired") })
			return nil, attempt
		}
		d := reconnectDelay(attempt, l.backoffBase, l.backoffCap, rand.Int64N)
		if d > left {
			d = left
		}
		t := time.NewTimer(d)
		select {
		case <-stop:
			t.Stop()
			return nil, attempt
		case <-retry:
			t.Stop()
		case <-t.C:
		}
		if !a.requestActive(rg) {
			return nil, attempt
		}
		if time.Until(expiresAt) <= 0 {
			a.reqUpdate(rg, func(l *requestLane) { l.endLocked("ended", "expired") })
			return nil, attempt
		}
		sc, res := a.hostJoin(rg, server, roomID, hostToken)
		if sc == nil && res == 0 {
			return nil, attempt
		}
		switch res {
		case signaling.HostJoined:
			if !a.reqUpdate(rg, func(l *requestLane) {
				l.setStateLocked(back, backCode)
				l.reconnectUntil = time.Time{}
			}) {
				a.releaseRequestSocket(sc, false)
				return nil, attempt
			}
			if back == "waiting" {
				// A reopen written on the socket that died may never have
				// reached the server, and a reclaim keeps a sealed room
				// sealed (spec 04 5.7), so say again that the link waits. On a
				// room that is open already it changes nothing.
				_ = sc.RequestReopen()
			}
			return sc, attempt + 1
		case signaling.HostTimeout, signaling.HostDown:
			// One failed attempt; the next one waits longer.
			if sc != nil {
				a.releaseRequestSocket(sc, false)
			}
			attempt++
			continue
		}
		if sc != nil {
			a.releaseRequestSocket(sc, false)
		}
		a.reqFail(rg, joinCode(res))
		return nil, attempt
	}
}

// requestPairing is what one pairing reads when its visitor arrives: the
// link's own server, the Hide my IP and global stats switches as they are
// right now (read under a.mu, then released), and the link's label, base
// folder, end time and stop channel (read under the lane lock).
type requestPairing struct {
	server      string
	hideIP      bool
	reportStats bool
	label       string
	saveDir     string
	expiresAt   time.Time
	stop        <-chan struct{}
}

// pairRequest is the default pairFn: it reads the pairing, then runs the drop
// (runRequestDrop, transfer.go).
func (a *App) pairRequest(rg uint64, sc *signaling.Client) {
	a.mu.Lock()
	hideIP, reportStats := a.cfg.HideIP, a.cfg.ReportStats
	a.mu.Unlock()
	l := a.lane()
	l.mu.Lock()
	if rg != l.gen || l.cancelled {
		l.mu.Unlock()
		return
	}
	p := requestPairing{
		server: l.server, hideIP: hideIP, reportStats: reportStats,
		label: l.label, saveDir: l.saveDir, expiresAt: l.expiresAt, stop: l.stop,
	}
	l.mu.Unlock()
	_ = a.runRequestDrop(rg, sc, p)
}

// setRequestConn registers a pairing's peer connection with generation rg, so
// Close link and quit can close it. False when rg no longer owns the lane: the
// caller closes conn itself.
func (a *App) setRequestConn(rg uint64, conn closer) bool {
	l := a.lane()
	l.mu.Lock()
	defer l.mu.Unlock()
	if rg != l.gen || l.cancelled {
		return false
	}
	l.conn = conn
	return true
}

// clearRequestConn forgets conn when the lane still holds it; one that Close
// link or a quit took is theirs.
func (a *App) clearRequestConn(conn closer) {
	l := a.lane()
	l.mu.Lock()
	if l.conn == conn {
		l.conn = nil
	}
	l.mu.Unlock()
}

// setDropCancel stores the running drop's cancel func for Cancel drop, gated
// on rg still owning the lane.
func (a *App) setDropCancel(rg uint64, cancel func()) bool {
	l := a.lane()
	l.mu.Lock()
	defer l.mu.Unlock()
	if rg != l.gen || l.cancelled {
		return false
	}
	l.dropCancel = cancel
	return true
}

// reopenRequest ends a pairing that made no drop: request-reopen on the link's
// socket, then waiting with code (visitor-left, setup-failed, no-relay,
// relay-unknown, or "" for a missed request, whose missedAt is already set).
// The reopen goes first, so a snapshot that says waiting never precedes it.
func (a *App) reopenRequest(rg uint64, sc *signaling.Client, code string, cause error) error {
	if !a.requestActive(rg) {
		return cause
	}
	_ = sc.RequestReopen()
	a.waitAgain(rg, code)
	return cause
}

// waitAgain puts generation rg back in waiting with code after a pairing that
// made no drop, without touching the room: for reopenRequest, and for a
// pairing whose seat a new visitor already holds.
func (a *App) waitAgain(rg uint64, code string) {
	a.reqUpdate(rg, func(l *requestLane) {
		l.prompt = nil
		l.route = ""
		l.dropCancel = nil
		l.setStateLocked("waiting", code)
	})
}

// sendCloseWithin writes request-close through closeFrame, waiting at most
// wait for the write. The write goroutine is left to finish on its own: the
// engine's 10 s write deadline bounds it.
func sendCloseWithin(sc *signaling.Client, closeFrame func(*signaling.Client) error, wait time.Duration) {
	done := make(chan struct{})
	go func() {
		_ = closeFrame(sc)
		close(done)
	}()
	t := time.NewTimer(wait)
	select {
	case <-done:
	case <-t.C:
	}
	t.Stop()
}

// requestTeardown sends request-close best effort, waiting at most wait for
// the write, then closes conn and then sc. Nothing user-facing waits on the
// write: Close link has already emitted its ended snapshot.
func requestTeardown(sc *signaling.Client, conn closer, wait time.Duration, closeFrame func(*signaling.Client) error) {
	if sc != nil {
		sendCloseWithin(sc, closeFrame, wait)
	}
	if conn != nil {
		conn.Close()
	}
	if sc != nil {
		sc.Close()
	}
}

// CloseRequestLink closes the open link: the generation ends at once (its
// goroutine goes silent), the snapshot shows ended closed, then request-close
// is sent best effort and the handles close. In receiving it does nothing:
// the link is used up and the view offers Cancel drop there.
func (a *App) CloseRequestLink() {
	l := a.lane()
	l.mu.Lock()
	if !liveState(l.state) || l.state == "receiving" {
		l.mu.Unlock()
		return
	}
	sc, conn := l.detachLocked()
	l.endLocked("ended", "closed")
	wait, closeFrame := l.closeWait, l.closeFrameFn
	l.mu.Unlock()
	a.attentionOff()
	a.emitCurrent()
	requestTeardown(sc, conn, wait, closeFrame)
}

// laneRequest is the request lane's name in the wake guard (wake.go); its
// generations count apart from the transfer lane's.
const laneRequest = "request"

// requestQuitWait bounds the request-close write on a quit, which the quit
// itself never waits for.
const requestQuitWait = time.Second

// requestWakeAcquire keeps the PC awake for drop generation rg: from Accept
// only, never at Make link or while a link waits (BP QUESTIONS[28]).
func (a *App) requestWakeAcquire(rg uint64) {
	if a.wake != nil {
		a.wake.acquire(laneRequest, rg)
	}
}

// requestWakeRelease drops rg's hold; a no-op when rg does not hold it.
func (a *App) requestWakeRelease(rg uint64) {
	if a.wake != nil {
		a.wake.release(laneRequest, rg)
	}
}

// closeForQuit ends the lane for a quit (ConfirmClose and shutdown): the
// generation ends, the wake hold goes, the peer connection closes at once, and
// request-close is fired on its own goroutine with a 1 s wait before the
// socket closes there. The quit never waits on the network: a lost
// request-close only leaves the reservation for its 10-minute grace, and
// visitors get host-absent (spec 06 4.9). The socket closes on that goroutine
// rather than here because closing it first would drop the request-close,
// and closing it after the write would make the quit wait for the write.
// Idempotent, and safe on a lane that never made a link.
func (l *requestLane) closeForQuit() {
	l.mu.Lock()
	old := l.gen
	wasLive := liveState(l.state)
	sc, conn := l.detachLocked()
	if wasLive {
		l.endLocked("ended", "app-closed")
	}
	closeFrame := l.closeFrameFn
	app := l.app
	l.mu.Unlock()
	if app != nil {
		app.requestWakeRelease(old)
		app.attentionOff()
	}
	if conn != nil {
		conn.Close()
	}
	if sc != nil {
		go func() {
			sendCloseWithin(sc, closeFrame, requestQuitWait)
			sc.Close()
		}()
	}
}

// withLaptopPower returns warnings with the laptop-power code once, last
// (E-27): no power-state API is asked, so every prompt carries the generic
// line. The display is never held on; the lane warns only (E-47, OD-31).
func withLaptopPower(warnings []string) []string {
	out := make([]string, 0, len(warnings)+1)
	for _, w := range warnings {
		if w != "laptop-power" {
			out = append(out, w)
		}
	}
	return append(out, "laptop-power")
}

// openPrompt moves generation rg to deciding with p, the prompt the Decide
// callback computed (S1-DSK-03b), and returns its promptGen; 0 when rg no
// longer owns the lane. A stale answer left in decision is drained first so
// it can never answer this prompt.
func (a *App) openPrompt(rg uint64, p RequestPrompt) uint64 {
	var pg uint64
	var quiet bool
	if !a.reqUpdate(rg, func(l *requestLane) {
		select {
		case <-l.decision:
		default:
		}
		l.promptGen++
		pg = l.promptGen
		p.Warnings = withLaptopPower(p.Warnings)
		l.prompt = &p
		l.setStateLocked("deciding", "")
		quiet = l.pruneEndsLocked()
		l.suggestClose = quiet
	}) {
		return 0
	}
	a.onPrompt(rg, quiet)
	return pg
}

// endPrompt is the end of a prompt that was not accepted: declined, timed
// out, or the visitor left while the owner decided. The flash stops, the title
// is Floe again, and the end is counted for E-40.
func (a *App) endPrompt(rg uint64) {
	l := a.lane()
	l.mu.Lock()
	if rg == l.gen {
		l.promptEnds = append(l.promptEnds, l.now())
		l.pruneEndsLocked()
	}
	l.mu.Unlock()
	a.attentionOff()
}

// acceptDrop is Accept's lane half, run by the Decide callback once the
// exclusive subfolder exists: receiving, and the wake hold for
// ("request", rg). False when rg no longer owns the lane (nothing held). An
// Accept ends the prompt's attention and resets the E-40 count.
func (a *App) acceptDrop(rg uint64) bool {
	if !a.reqUpdate(rg, func(l *requestLane) {
		l.prompt = nil
		l.promptEnds = nil
		l.suggestClose = false
		l.setStateLocked("receiving", "")
	}) {
		return false
	}
	a.attentionOff()
	a.requestWakeAcquire(rg)
	return true
}

// endDrop is the one exit of an accepted drop: done, or stopped with its code
// (the engine's, the owner's Cancel drop, a visitor leave, the time limit),
// with the result, and the wake hold released. The release is not gated on
// rg still owning the lane: a quit that moved the generation on must not
// leave the PC held awake. Done sends TO2; a stop the owner did not cause
// sends TO3; the owner's own Cancel drop sends nothing.
func (a *App) endDrop(rg uint64, state, code string, res *RequestResult) {
	a.requestWakeRelease(rg)
	var ownerStop bool
	if !a.reqUpdate(rg, func(l *requestLane) {
		ownerStop = l.ownerStop
		l.ownerStop = false
		l.result = res
		l.dropCancel = nil
		l.endLocked(state, code)
	}) {
		return
	}
	switch {
	case state == "done":
		a.notifyRequest(rg, toastDropDone)
	case state == "stopped" && !ownerStop:
		a.notifyRequest(rg, toastDropFailed)
	}
}

// requestSpamWindow is E-40's window: two prompts ending without Accept
// within it silence the toast for the next ones.
const requestSpamWindow = 10 * time.Minute

// pruneEndsLocked drops prompt ends older than the E-40 window and reports
// whether two or more remain: then the toast stays quiet and the snapshot
// suggests closing the link (the flash and the title still fire).
func (l *requestLane) pruneEndsLocked() bool {
	cut := l.now().Add(-requestSpamWindow)
	kept := l.promptEnds[:0]
	for _, t := range l.promptEnds {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	l.promptEnds = kept
	return len(kept) >= 2
}

// requestToast names one of the three fixed notifications the lane may send.
// Nothing else can reach a Windows toast from this lane: go-toast falls back
// to a PowerShell script on any COM error, where a visitor string could run
// a command (spec 05 section 10, L14), so the text is a closed set of
// constants and never the label, a name, a count or engine text.
type requestToast int

const (
	toastRequestArrived requestToast = iota + 1 // TO1
	toastDropDone                               // TO2
	toastDropFailed                             // TO3
)

// requestToastText is the constant table (approved copy TO1 to TO3). An
// unknown key has no text and sends nothing.
func requestToastText(t requestToast) (title, body string, ok bool) {
	switch t {
	case toastRequestArrived:
		return "Floe", "Someone wants to send you files. Open Floe to answer.", true
	case toastDropDone:
		return "Floe", "Files received.", true
	case toastDropFailed:
		return "Floe - receive failed", "The transfer did not complete. Open Floe to see what happened.", true
	}
	return "", "", false
}

// notifyRequest is the lane's only way to a notification: a table key, gated
// on rg still owning the lane. TestNoDirectNotifyInRequestLane keeps it so.
func (a *App) notifyRequest(rg uint64, t requestToast) {
	title, body, ok := requestToastText(t)
	if !ok || !a.requestActive(rg) {
		return
	}
	a.notify(title, body)
}

// Window titles: "(1) Floe" while a prompt waits, "Floe" otherwise (T1). The
// frameless window draws its own lockup, so this is what the taskbar button
// and Alt+Tab show.
const (
	titlePrompt = "(1) Floe"
	titleIdle   = "Floe"
)

// setTitle sets the window title through the seam, or the Wails runtime when
// the app has a window.
func (a *App) setTitle(title string) {
	l := a.lane()
	if l.setTitleFn != nil {
		l.setTitleFn(title)
		return
	}
	a.mu.Lock()
	ctx := a.ctx
	a.mu.Unlock()
	if ctx != nil {
		runtime.WindowSetTitle(ctx, title)
	}
}

// flash turns the taskbar flash on or off through the seam.
func (a *App) flash(on bool) {
	l := a.lane()
	if l.flashFn != nil {
		l.flashFn(on)
		return
	}
	if on {
		flashTaskbar()
	} else {
		stopFlash()
	}
}

// onPrompt gets the owner's attention for a new prompt: the flash, the
// "(1) Floe" title, and TO1 unless E-40 has quieted the toast. No visitor
// value is passed to any of them.
func (a *App) onPrompt(rg uint64, quiet bool) {
	l := a.lane()
	l.mu.Lock()
	active := rg == l.gen && !l.cancelled
	if active {
		l.attention = true
		l.attentionSeq++
	}
	l.mu.Unlock()
	if !active {
		return
	}
	a.applyAttention()
	if !quiet {
		a.notifyRequest(rg, toastRequestArrived)
	}
}

// attentionOff stops the flash and restores the title, once, whatever ended
// the prompt: an answer, a timeout, a visitor leave, Close link or quit.
func (a *App) attentionOff() {
	l := a.lane()
	l.mu.Lock()
	on := l.attention
	l.attention = false
	if on {
		l.attentionSeq++
	}
	l.mu.Unlock()
	if on {
		a.applyAttention()
	}
}

// applyAttention puts the flash and the title where the lane says they
// should be. The calls run with no lock held: from a goroutine the title is
// a cross-thread SendMessage that waits for the UI thread, and shutdown runs
// on that thread after its message loop has stopped, so a lock held across
// them could hang a quit. Two changes can therefore interleave their calls
// (a Close link racing a prompt left "(1) Floe" on a closed link, review 1a
// F3), so each caller reads the lane again after applying and applies again
// while another change came in meanwhile: the last call to land is always
// for the lane's latest state.
func (a *App) applyAttention() {
	l := a.lane()
	for {
		l.mu.Lock()
		on, seq := l.attention, l.attentionSeq
		l.mu.Unlock()
		if on {
			a.flash(true)
			a.setTitle(titlePrompt)
		} else {
			a.flash(false)
			a.setTitle(titleIdle)
		}
		l.mu.Lock()
		settled := l.attentionSeq == seq
		l.mu.Unlock()
		if settled {
			return
		}
	}
}

// AnswerRequest answers the prompt promptGen (spec 06 4.3). A stale promptGen
// is ignored, so a prompt left on screen across a reconnect never answers a
// request the lane already dropped. accept and decline go to the Decide
// callback; keep-waiting and close answer the Declined follow-up.
func (a *App) AnswerRequest(promptGen uint64, answer string) RequestLinkSnapshot {
	l := a.lane()
	l.mu.Lock()
	if promptGen == 0 || promptGen != l.promptGen || l.cancelled {
		snap := l.snapshotLocked()
		l.mu.Unlock()
		return snap
	}
	switch {
	case l.state == "deciding" && (answer == "accept" || answer == "decline"):
		select {
		case l.decision <- reqAnswer{promptGen: promptGen, answer: answer}:
		default:
		}
	case l.state == "declined" && answer == "keep-waiting":
		rg, sc := l.gen, l.sc
		l.setStateLocked("waiting", "")
		l.mu.Unlock()
		if sc != nil {
			_ = sc.RequestReopen()
		}
		a.emitState(rg)
		return a.GetRequestLink()
	case l.state == "declined" && answer == "close":
		l.mu.Unlock()
		a.CloseRequestLink()
		return a.GetRequestLink()
	}
	snap := l.snapshotLocked()
	l.mu.Unlock()
	return snap
}

// CancelRequestDrop stops a running drop through the cancel func the drop
// registered (S1-DSK-03b), which returns at once: it sends stopped and closes
// on its own goroutine, and the drop ends when its receive returns, which a
// commit retry can hold for up to 5 minutes (WP-A2 review L3b). Outside
// receiving it does nothing.
func (a *App) CancelRequestDrop() {
	l := a.lane()
	l.mu.Lock()
	cancel := l.dropCancel
	receiving := l.state == "receiving"
	if receiving && cancel != nil {
		l.ownerStop = true // the owner's own stop is not a failure: no TO3
	}
	l.mu.Unlock()
	if receiving && cancel != nil {
		cancel()
	}
}

// GetRequestLink returns the full snapshot for mount and remount. It takes
// the lane mutex only, never a.mu.
func (a *App) GetRequestLink() RequestLinkSnapshot {
	l := a.lane()
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.snapshotLocked()
}

// RetryRequestLink runs the next reconnect attempt at once. Outside
// reconnecting it does nothing.
func (a *App) RetryRequestLink() {
	l := a.lane()
	l.mu.Lock()
	retry := l.retry
	reconnecting := l.state == "reconnecting"
	l.mu.Unlock()
	if !reconnecting || retry == nil {
		return
	}
	select {
	case retry <- struct{}{}:
	default:
	}
}
