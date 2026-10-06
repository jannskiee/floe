//go:build !windows

package main

// Delivery of an OS toast off Windows. The _other suffix is not a GOOS suffix,
// so the build line above is what keeps this file out of the Windows build.
// There is no silent push elsewhere: Wails' notification is all there is, and
// the sound preference does not reach it. The toast guard lets only
// toast_windows.go import go-toast, so this file carries only these two
// functions.

import (
	"context"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func pushToast(ctx context.Context, title, body string, silent bool) {
	_ = runtime.SendNotification(ctx, runtime.NotificationOptions{Title: title, Body: body})
}

// setToastDisplayName: the sender's name is a Windows registry matter.
func setToastDisplayName() {}
