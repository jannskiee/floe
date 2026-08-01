//go:build !windows

package transfer

// applyMOTW is a no-op off Windows: the Mark-of-the-Web / Zone.Identifier stream
// is a Windows-only concept.
func applyMOTW(path string) error { return nil }
