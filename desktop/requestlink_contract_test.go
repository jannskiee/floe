package main

// The wire names of the two structs the bindings contract freezes. These stay
// when the stubs go: the frontend reads these exact keys.

import (
	"encoding/json"
	"testing"
)

// TestRequestLinkSnapshotJSONShape pins the wire names the frontend reads, so a
// renamed Go field cannot silently turn a frontend read into undefined.
func TestRequestLinkSnapshotJSONShape(t *testing.T) {
	snap := RequestLinkSnapshot{
		State: "deciding", Code: "", Gen: 3, PromptGen: 2, Link: "l", Label: "x",
		SaveDir: "d", ExpiresAt: 1, Route: "direct", ReconnectUntil: 2, MissedAt: 3,
		SuggestClose: true,
		Prompt:       &RequestPrompt{Files: 1, TotalBytes: 2, Folder: "f", FreeBytes: 3, Warnings: []string{"low-space"}, AnswerBy: 4},
		Result:       &RequestResult{Files: 1, Saved: 1, Bytes: 2, Verified: 1, Renamed: 0, Folder: "f", Names: []string{"a"}},
	}
	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"state", "code", "gen", "promptGen", "link", "label", "saveDir", "expiresAt", "route", "reconnectUntil", "missedAt", "suggestClose", "prompt", "result"} {
		if _, ok := m[k]; !ok {
			t.Errorf("snapshot JSON lacks %q: %s", k, raw)
		}
	}
	prompt := m["prompt"].(map[string]any)
	for _, k := range []string{"files", "totalBytes", "folder", "freeBytes", "warnings", "answerBy"} {
		if _, ok := prompt[k]; !ok {
			t.Errorf("prompt JSON lacks %q", k)
		}
	}
	result := m["result"].(map[string]any)
	for _, k := range []string{"files", "saved", "bytes", "verified", "renamed", "folder", "names"} {
		if _, ok := result[k]; !ok {
			t.Errorf("result JSON lacks %q", k)
		}
	}
	// No pendingRename (E-36) and no token-shaped field of any kind.
	for _, k := range []string{"pendingRename", "hostToken", "token", "roomId", "linkId"} {
		if _, ok := m[k]; ok {
			t.Errorf("snapshot JSON carries %q", k)
		}
		if _, ok := result[k]; ok {
			t.Errorf("result JSON carries %q", k)
		}
	}
}

// TestFeatureResultJSONShape pins the probe result the Settings switch reads.
func TestFeatureResultJSONShape(t *testing.T) {
	raw, err := json.Marshal(FeatureResult{Reachable: true, RequestLinks: true})
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `{"reachable":true,"requestLinks":true}` {
		t.Errorf("FeatureResult JSON = %s", raw)
	}
}
