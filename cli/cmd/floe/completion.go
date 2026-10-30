package main

import (
	"errors"
	"net"
	"strings"

	"github.com/spf13/cobra"

	"github.com/jannskiee/floe/cli/engine/peer"
)

var listInterfaces = net.Interfaces

// Match the transfer engine's case-insensitive substring rule for --iface.
// Listing names never needs interface addresses or a connection to a peer.
func completeIface(_ *cobra.Command, _ []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	interfaces, err := listInterfaces()
	if err != nil {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	var names []string
	match := strings.ToLower(toComplete)
	for _, iface := range interfaces {
		if strings.Contains(strings.ToLower(iface.Name), match) {
			names = append(names, iface.Name)
		}
	}
	return names, cobra.ShellCompDirectiveNoFileComp
}

var errIfaceNoMatch = errors.New("--iface matches no network interface on this computer; check the name, or drop the flag")

// checkIface fails before any network call when --iface names nothing on this
// computer. pion would otherwise gather no candidate, and floe would find out
// only after pairing, which retires the code. It uses the engine's own filter
// and counts only interfaces that are up and not loopback, as ICE does; no
// names, or no readable list, goes ahead as before.
func checkIface(_ *cobra.Command, _ []string) error {
	allow := peer.MakeInterfaceAllowFilter(flagIface)
	if allow == nil {
		return nil
	}
	interfaces, err := listInterfaces()
	if err != nil {
		return nil
	}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if allow(iface.Name) {
			return nil
		}
	}
	return errIfaceNoMatch
}
