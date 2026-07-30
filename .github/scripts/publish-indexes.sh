#!/usr/bin/env bash
#
# Merges the per-platform build legs into one multi-arch index per image and
# applies the release tags.
#
# Structured deliberately as validate-everything-then-publish-everything. The
# obvious shape, "validate server, publish server, validate client, publish
# client", puts two network round-trips between the two tag moves, so a transient
# registry error in the middle leaves the server released and the client behind.
# docker-compose.yml pins both images to the same tag, so a mismatched pair is a
# broken stack for every self-hoster who pulls during that window.
set -euo pipefail

# shellcheck source=.github/scripts/manifest-lib.sh
. "$(dirname "$0")/manifest-lib.sh"

: "${SERVER:?SERVER must be set}"
: "${CLIENT:?CLIENT must be set}"
: "${TAGS_SERVER:?TAGS_SERVER must be set}"
: "${TAGS_CLIENT:?TAGS_CLIENT must be set}"

# ---- validate every leg of both images, before anything is published ---------

declare -A LEG=()
for pair in "server:$SERVER" "client:$CLIENT"; do
    name="${pair%%:*}"
    image="${pair#*:}"
    for platform in amd64 arm64; do
        digest="$(leg_digest "$name" "$platform")"
        # Asserts the leg is a single linux manifest of the expected architecture
        # and returns the child the smoke test actually ran.
        child="$(child_digest "${image}@${digest}" "$platform")"
        LEG["${name}-${platform}-leg"]="$digest"
        LEG["${name}-${platform}-child"]="$child"
        echo "ok  ${name} linux/${platform}  leg=${digest}  smoke-tested child=${child}"
    done
done

# Captured into a variable first, deliberately. `mapfile -t X < <(f)` runs f in a
# process substitution whose exit status set -e never observes, so a failing
# tag_args would be silently discarded and imagetools would run with zero -t
# arguments: a green run that published nothing. Verified: that form survives
# with count=0.
server_tag_args="$(tag_args "$TAGS_SERVER")"
client_tag_args="$(tag_args "$TAGS_CLIENT")"
mapfile -t SERVER_ARGS <<< "$server_tag_args"
mapfile -t CLIENT_ARGS <<< "$client_tag_args"

if [ "${#SERVER_ARGS[@]}" -eq 0 ] || [ "${#CLIENT_ARGS[@]}" -eq 0 ]; then
    echo "::error::refusing to publish with an empty tag list" >&2
    exit 1
fi

# ---- publish, with nothing between the two creates ---------------------------

docker buildx imagetools create "${SERVER_ARGS[@]}" \
    "${SERVER}@${LEG[server-amd64-leg]}" \
    "${SERVER}@${LEG[server-arm64-leg]}"

docker buildx imagetools create "${CLIENT_ARGS[@]}" \
    "${CLIENT}@${LEG[client-amd64-leg]}" \
    "${CLIENT}@${LEG[client-arm64-leg]}"

echo "published both indexes"
