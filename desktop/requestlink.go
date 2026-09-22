package main

// The Request link lane's bound surface (spec 06 4.3 and 4.4). This file holds
// the bindings contract's six lane methods and the snapshot the frontend sees,
// frozen so the frontend and the Go lane can be built at the same time. The
// other two contract methods live with their concerns: SetRequestLinks in
// endpoints.go, RequestLinkSupport in serverprobe.go. Every method here is a
// stub that answers "not available". None of them can report a success, so a
// link can never appear to work before the real lane replaces them.
//
// Deliberately no *App fields, no goroutines and no network: a stub that did
// anything could be mistaken for the feature.

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

// MakeRequestLink makes one request link (spec 06 4.3). Stub: always refuses
// with the disabled code, the same answer a server without request-1 gives.
func (a *App) MakeRequestLink(label string, saveDir string, lifetime string) RequestLinkSnapshot {
	return RequestLinkSnapshot{State: "error", Code: "disabled"}
}

// CloseRequestLink closes the open link. Stub: there is never a link to close.
func (a *App) CloseRequestLink() {}

// AnswerRequest answers the prompt promptGen with accept, decline,
// keep-waiting or close. Stub: there is never a prompt, so nothing is sent.
func (a *App) AnswerRequest(promptGen uint64, answer string) RequestLinkSnapshot {
	return RequestLinkSnapshot{State: "off"}
}

// CancelRequestDrop stops a running drop. Stub: there is never a drop.
func (a *App) CancelRequestDrop() {}

// GetRequestLink returns the full snapshot for mount and remount. Stub: off.
func (a *App) GetRequestLink() RequestLinkSnapshot {
	return RequestLinkSnapshot{State: "off"}
}

// RetryRequestLink runs the next reconnect attempt at once. Stub: nothing is
// ever reconnecting.
func (a *App) RetryRequestLink() {}
