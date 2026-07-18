# Unraid templates

Floe uses two containers. Install `floe-server.xml` first, followed by
`floe-client.xml`.

For direct access on a local network:

1. Give the server a host port (the default is `3001`).
2. Set the server's **Client URL** to the exact client origin that browsers open,
   for example `http://192.168.1.10:3000`.
3. Give the client a Web UI port (the default is `3000`).
4. Set the client's **Signaling Server Port** to the server host port.

The client derives the signaling URL from the browser hostname and that port. If
the services are published through HTTPS or separate hostnames, set the client's
**Signaling Server URL** to the complete public URL instead.

The templates use multi-architecture images from GitHub Container Registry and do
not require application-data volumes. See the
[Unraid deployment guide](../docs/self-hosting/unraid.mdx) for installation,
reverse proxy, TURN, and troubleshooting details.
