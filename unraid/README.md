# Unraid templates

Floe uses two containers. Install `floe-server.xml` first, followed by
`floe-client.xml`.

For direct access on a local network:

1. Give the server a host port (the default is `3001`).
2. Set the server's **Client URL** to the exact client origin that browsers open,
   for example `http://192.168.1.10:3000`.
3. Give the client a Web UI port (the default is `3000`).
4. Set the client's **Signaling Server URL** to `http://<unraid-ip>:<server-port>`,
   for example `http://192.168.1.10:3001`.

Publishing both services through a single HTTPS domain? Clear **Signaling Server
URL**, which ships holding the placeholder `http://YOUR-UNRAID-IP:3001`, and the
browser uses the domain it loaded from. On two separate hostnames, set it to the
full public signaling origin.

The templates use multi-architecture images from GitHub Container Registry and do
not require application-data volumes, with one exception: request links. They stay
off until a policy file turns them on, and the Floe-Server template ships only the
**Request Link Policy File** variable, not the Path mapping that makes the file
visible inside the container. Add a Path that maps the folder holding the file,
read-only, to a container folder such as `/app/policy`, then set the variable to
the file's path inside the container, such as `/app/policy/policy.json`. The steps
are in the
[Request links](https://www.floe.one/docs/self-hosting/unraid#request-links)
section of the Unraid guide.

See [Deploy on Unraid](https://www.floe.one/docs/self-hosting/unraid) for
installation, reverse proxy, TURN, request links, and container updates.
