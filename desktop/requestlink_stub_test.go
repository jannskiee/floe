package main

// Pins the bindings contract's one promise: no stub can report a success, so
// the Beta switch cannot appear to work before the real lane exists. Each test
// goes when the code it covers is replaced: the lane test with the six lane
// stubs, the settings test with SetRequestLinks and RequestLinkSupport.

import "testing"

// liveStates are the snapshot states that would mean a link or a drop exists.
var liveStates = map[string]bool{
	"making": true, "waiting": true, "reconnecting": true, "connecting": true,
	"deciding": true, "declined": true, "receiving": true, "done": true,
}

func TestRequestLaneStubsNeverSucceed(t *testing.T) {
	a := &App{}

	made := a.MakeRequestLink("Acme footage", t.TempDir(), "24h")
	if made.State != "error" || made.Code != "disabled" {
		t.Errorf("MakeRequestLink = %+v, want state error with code disabled", made)
	}
	if made.Link != "" || made.Prompt != nil || made.Result != nil {
		t.Errorf("MakeRequestLink carried a link, prompt or result: %+v", made)
	}

	for name, snap := range map[string]RequestLinkSnapshot{
		"GetRequestLink":         a.GetRequestLink(),
		"AnswerRequest accept":   a.AnswerRequest(1, "accept"),
		"AnswerRequest decline":  a.AnswerRequest(1, "decline"),
		"AnswerRequest unknown":  a.AnswerRequest(0, "anything"),
		"MakeRequestLink (7 d)":  a.MakeRequestLink("", "", "7d"),
		"MakeRequestLink (junk)": a.MakeRequestLink("", "", "junk"),
	} {
		if liveStates[snap.State] {
			t.Errorf("%s returned live state %q", name, snap.State)
		}
		if snap.Link != "" {
			t.Errorf("%s returned a link", name)
		}
	}

	// The three void methods must be callable on a bare App with nothing open.
	a.CloseRequestLink()
	a.CancelRequestDrop()
	a.RetryRequestLink()
}

func TestSettingsStubsNeverSucceed(t *testing.T) {
	a := &App{}
	if err := a.SetRequestLinks(true); err == nil {
		t.Error("SetRequestLinks(true) succeeded; the switch would appear to turn on")
	}
	if err := a.SetRequestLinks(false); err != nil {
		t.Errorf("SetRequestLinks(false) = %v; off is the only true answer", err)
	}
	if got := a.RequestLinkSupport(); got.Reachable || got.RequestLinks {
		t.Errorf("RequestLinkSupport = %+v, want not reachable and no request-1", got)
	}
}
