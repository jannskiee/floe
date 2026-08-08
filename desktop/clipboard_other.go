//go:build !windows

package main

// Clipboard paste reads Windows clipboard formats (CF_HDROP, the registered
// "PNG" format); these stubs keep the module compiling elsewhere and make paste
// read as "nothing on the clipboard".

func clipboardFilePaths() []string { return nil }

func clipboardImagePNG() []byte { return nil }
