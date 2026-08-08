//go:build windows

package main

import (
	"golang.org/x/sys/windows/registry"
)

// registerContextMenu writes the per-user "Send with Floe" Explorer verb
// pointing at exe. HKCU needs no admin rights and no installer.
func registerContextMenu(base, exe string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, base, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if err := k.SetStringValue("", "Send with Floe"); err != nil {
		return err
	}
	if err := k.SetStringValue("Icon", exe); err != nil {
		return err
	}
	cmd, _, err := registry.CreateKey(registry.CURRENT_USER, base+`\command`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer cmd.Close()
	return cmd.SetStringValue("", expectedCommand(exe))
}

// unregisterContextMenu removes the verb; a missing key is not an error.
// The command subkey must go first: DeleteKey only removes leaf keys.
func unregisterContextMenu(base string) error {
	if err := registry.DeleteKey(registry.CURRENT_USER, base+`\command`); err != nil && err != registry.ErrNotExist {
		return err
	}
	if err := registry.DeleteKey(registry.CURRENT_USER, base); err != nil && err != registry.ErrNotExist {
		return err
	}
	return nil
}

// contextMenuCommand reads the stored launch command, reporting whether the
// verb is registered at all.
func contextMenuCommand(base string) (string, bool) {
	k, err := registry.OpenKey(registry.CURRENT_USER, base+`\command`, registry.QUERY_VALUE)
	if err != nil {
		return "", false
	}
	defer k.Close()
	s, _, err := k.GetStringValue("")
	if err != nil {
		return "", false
	}
	return s, true
}
