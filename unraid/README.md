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

Publishing both services through a single HTTPS domain? Leave **Signaling Server
URL** empty, which is how it ships, and the browser uses the domain it loaded
from. On two separate hostnames, set it to the full public signaling origin.

A Floe-Client added from an earlier copy of the template holds the placeholder
`http://YOUR-UNRAID-IP:3001` in that field, as its value and as its default, and
Unraid puts a field's default back whenever the field is left empty. To empty it
on such a container, turn on **Advanced View**, click **Edit** beside the field,
and clear **Default Value** as well.

The templates use multi-architecture images from GitHub Container Registry and do
not require application-data volumes, with one exception: request links. They stay
off until a policy file turns them on. The Floe-Server template has two advanced
fields for it, both empty until you fill them in. Set **Request Link Policy
Folder** to the folder on your server that holds the file, for example
`/mnt/user/appdata/floe/policy`; the template mounts it read-only at `/app/policy`.
Then set **Request Link Policy File** to the file's path inside the container,
such as `/app/policy/policy.json`. The steps are in the
[Request links on Unraid](https://www.floe.one/docs/self-hosting/unraid#request-links)
section of the Unraid guide.

See [Deploy on Unraid](https://www.floe.one/docs/self-hosting/unraid) for
installation, reverse proxy, TURN, request links, and container updates.
