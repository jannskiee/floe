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
	// The stubs return 0: they never report anything worth ordering.
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

	// The link's secrets, in memory only; endLocked forgets them.
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

	stop  chan struct{} // closed when this link's generation ends
	retry chan struct{} // buffered 1; Retry now

	// live mirrors liveState(state) for readers that must not take mu: the
	// close guard runs on the Windows message-pump thread.
	live atomic.Bool

	// pairFn is the pairing body, run on user-connected by the goroutine that
	// owns sc. S1-DSK-03b fills it; the default reopens the room so the link
	// stays waiting.
	pairFn func(rg uint64, sc *signaling.Client)

	// emitMu serializes building and emitting snapshots, so two emits can
	// never reach the frontend in the opposite order to the state changes.
	emitMu sync.Mutex

	// Seams, fixed at construction. Tests replace them on a fresh lane
	// before any goroutine starts.
	emitFn      func(event string, data any)
	supportFn   func(server string) FeatureResult
	relayFn     func(server string) (hasRelay, degraded bool, err error)
	lifetimeFn  func(lifetime string) (time.Duration, bool)
	backoffBase time.Duration
	backoffCap  time.Duration
	closeWait   time.Duration

	wg sync.WaitGroup // lane goroutines, so tests can wait them out
}

// newRequestLane builds the lane for a, wired to the real probe, ICE fetch
// and emit.
func newRequestLane(a *App) *requestLane {
	l := &requestLane{
		decision:    make(chan reqAnswer, 1),
		supportFn:   requestLinkSupport,
		relayFn:     fetchRelay,
		lifetimeFn:  requestLifetime,
		backoffBase: requestBackoffBase,
		backoffCap:  requestBackoffCap,
		closeWait:   requestCloseWait,
	}
	l.pairFn = func(rg uint64, sc *signaling.Client) { a.pairStub(rg, sc) }
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
}

// detachLocked ends the owning generation (bump and cancel), wakes its
// goroutine and hands back the handles for the caller to close outside mu.
func (l *requestLane) detachLocked() (sc *signaling.Client, conn closer) {
	l.gen++
	l.cancelled = true
	if l.stop != nil {
		close(l.stop)
		l.stop = nil
	}
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

// clearRequestSignaling forgets sc if it is still rg's socket.
func (a *App) clearRequestSignaling(rg uint64, sc *signaling.Client) {
	l := a.lane()
	l.mu.Lock()
	defer l.mu.Unlock()
	if rg == l.gen && l.sc == sc {
		l.sc = nil
	}
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
	l.gen++
	rg := l.gen
	l.cancelled = false
	l.endLocked("", "")
	l.expiresAt = time.Time{}
	l.route, l.result, l.missedAt, l.suggestClose = "", nil, time.Time{}, false
	l.label = displayLabel(label)
	l.saveDir = strings.TrimSpace(saveDir)
	if l.saveDir == "" {
		l.saveDir = filepath.Join(defaultReceiveDir(), "Floe requests")
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
			a.clearRequestSignaling(rg, sc)
			sc.Close()
		}
		a.reqFail(rg, joinCode(res))
		return
	}
	link := requestLinkFor(web, linkID, roomID)
	if !a.reqUpdate(rg, func(l *requestLane) {
		l.link = link
		l.setStateLocked("waiting", "")
	}) {
		sc.Close()
		return
	}

	attempt := 0
	joinedAt := time.Now()
	for {
		switch a.waitRequest(rg, stop, sc, expiresAt) {
		case waitEnded:
			return
		case waitDown:
			a.clearRequestSignaling(rg, sc)
			sc.Close()
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

// hostJoin connects with liveness, registers the socket with the lane and
// makes the token join. A nil sc with result 0 means rg was superseded; a nil
// sc with HostDown means the connect itself failed.
func (a *App) hostJoin(rg uint64, server, roomID, hostToken string) (*signaling.Client, signaling.HostJoinResult) {
	sc, err := signaling.Connect(server, signaling.WithLiveness(requestPing, requestReadDeadline))
	if err != nil {
		if !a.requestActive(rg) {
			return nil, 0
		}
		return nil, signaling.HostDown
	}
	if !a.setRequestSignaling(rg, sc) {
		sc.Close()
		return nil, 0
	}
	res, _ := joinWithTokenFn(sc, roomID, hostToken)
	if !a.requestActive(rg) {
		a.clearRequestSignaling(rg, sc)
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
			a.clearRequestSignaling(rg, sc)
			sc.Close()
			a.reqFail(rg, c)
			return waitEnded
		case <-sc.Down:
			return waitDown
		case <-sc.PeerLeft:
			// A visitor who left before pairing, or the push that follows
			// Down, which the Down case decides on.
		}
	}
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
	a.clearRequestSignaling(rg, sc)
	if sc != nil {
		_ = sc.RequestClose()
		sc.Close()
	}
}

// reconnect retries the connect and the token join with full-jitter backoff
// until the link's own end time (E-34). A re-join after a server restart
// re-creates the reservation silently (E-06). It returns the new socket, or
// nil when the link ended.
func (a *App) reconnect(rg uint64, stop <-chan struct{}, server, roomID, hostToken string, expiresAt time.Time, attempt int) (*signaling.Client, int) {
	l := a.lane()
	if !a.reqUpdate(rg, func(l *requestLane) {
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
				l.setStateLocked("waiting", "")
				l.reconnectUntil = time.Time{}
			}) {
				sc.Close()
				return nil, attempt
			}
			return sc, attempt + 1
		case signaling.HostTimeout, signaling.HostDown:
			// One failed attempt; the next one waits longer.
			if sc != nil {
				a.clearRequestSignaling(rg, sc)
				sc.Close()
			}
			attempt++
			continue
		}
		if sc != nil {
			a.clearRequestSignaling(rg, sc)
			sc.Close()
		}
		a.reqFail(rg, joinCode(res))
		return nil, attempt
	}
}

// pairStub is the default pairFn until S1-DSK-03b: it reopens the room so the
// visitor is turned away and the link stays waiting.
func (a *App) pairStub(rg uint64, sc *signaling.Client) {
	if a.requestActive(rg) {
		_ = sc.RequestReopen()
	}
}

// requestTeardown sends request-close best effort, waiting at most wait for
// the write, then closes conn and then sc. The engine's own 10 s write
// deadline bounds a stuck write; nothing user-facing waits on this.
func requestTeardown(sc *signaling.Client, conn closer, wait time.Duration) {
	if sc != nil {
		done := make(chan struct{})
		go func() {
			_ = sc.RequestClose()
			close(done)
		}()
		t := time.NewTimer(wait)
		select {
		case <-done:
		case <-t.C:
		}
		t.Stop()
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
	wait := l.closeWait
	l.mu.Unlock()
	a.emitCurrent()
	requestTeardown(sc, conn, wait)
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
// registered (S1-DSK-03b). Outside receiving it does nothing.
func (a *App) CancelRequestDrop() {
	l := a.lane()
	l.mu.Lock()
	cancel := l.dropCancel
	receiving := l.state == "receiving"
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
