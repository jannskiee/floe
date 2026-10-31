package main

import (
	"net"
	"strings"

	"github.com/spf13/cobra"
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
