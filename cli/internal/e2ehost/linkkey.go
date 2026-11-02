package main

// The link key in a harness. "Bad" always means an honest proof under a different
// key, never a lie the engine was made to tell: the engine has no such hook and must
// not gain one, so the failing peer here is simply one that holds the wrong key.

import (
	"github.com/jannskiee/floe/cli/engine/linkkey"
	"github.com/jannskiee/floe/cli/engine/transfer"
)

const (
	kcModeBad  = "bad"
	kcModeNone = "none"
)

// validKCFlags reports whether -key and -kc go together: -kc only with -key, and
// only one of its two words, so a spec typo fails at the usage stage.
func validKCFlags(keyed bool, mode string) bool {
	switch mode {
	case "":
		return true
	case kcModeBad, kcModeNone:
		return keyed
	}
	return false
}

// harnessKeyCheck is what a harness holding the link's key acts with under mode:
// that key, another one, or none.
func harnessKeyCheck(key linkkey.Key, room, mode string) (*transfer.KeyCheck, error) {
	switch mode {
	case kcModeNone:
		return nil, nil
	case kcModeBad:
		other, err := linkkey.New()
		if err != nil {
			return nil, err
		}
		key = other
	}
	return &transfer.KeyCheck{Key: key, RoomID: room}, nil
}
