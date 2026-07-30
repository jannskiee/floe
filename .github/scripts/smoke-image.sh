#!/usr/bin/env bash
#
# Smoke-tests a built Floe image before any user-facing tag points at it.
#
# Lives in a script rather than inline YAML so the identical checks can be run
# locally against a local build before anything is pushed:
#
#   docker build -t floe-client:smoke ./client
#   .github/scripts/smoke-image.sh floe-client floe-client:smoke
#
# Usage: smoke-image.sh <floe-server|floe-client> <image-ref>
set -euo pipefail

NAME="${1:?usage: smoke-image.sh <floe-server|floe-client> <image-ref>}"
REF="${2:?usage: smoke-image.sh <floe-server|floe-client> <image-ref>}"

CONTAINERS=()
cleanup() {
    for c in "${CONTAINERS[@]:-}"; do
        [ -n "$c" ] || continue
        echo "--- logs: $c ---" >&2
        docker logs --tail 50 "$c" >&2 2>&1 || true
        docker rm -f "$c" >/dev/null 2>&1 || true
    done
}
trap cleanup EXIT

run() {
    local cname="$1" port="$2"
    shift 2
    docker run -d --name "$cname" -p "${port}:${port}" "$@" "$REF" >/dev/null
    CONTAINERS+=("$cname")
}

# Poll rather than sleep: the client's standalone server is usually up in under
# a second, but a cold CI runner can take several.
wait_for() {
    local url="$1"
    curl --fail --silent --show-error --retry 30 --retry-delay 1 \
        --retry-all-errors --max-time 60 -o /dev/null "$url"
}

fail() {
    echo "SMOKE FAIL: $*" >&2
    exit 1
}

case "$NAME" in
floe-server)
    run smoke-server 3001
    wait_for http://localhost:3001/health || fail "/health never came up"

    body="$(curl --fail --silent http://localhost:3001/health)"
    echo "$body" | grep -q '"status":"healthy"' \
        || fail "/health did not report healthy: $body"
    echo "OK  /health -> healthy"
    ;;

floe-client)
    # The client's /api/config just echoes SOCKET_URL, so this leg needs no
    # signaling server. Two runs with DIFFERENT values is the real proof that the
    # address is resolved at runtime and not baked, which is the whole premise of
    # shipping one image to everyone.
    run smoke-client 3000 -e SOCKET_URL=http://localhost:3001
    wait_for http://localhost:3000/ || fail "client never served /"
    echo "OK  / -> 200"

    cfg="$(curl --fail --silent http://localhost:3000/api/config)"
    [ "$cfg" = '{"socketUrl":"http://localhost:3001"}' ] \
        || fail "/api/config was $cfg, expected the SOCKET_URL value"
    echo "OK  /api/config reflects SOCKET_URL"

    # A broken sharp does NOT 500. Next silently falls back to serving the
    # original PNG, so status alone proves nothing: the content type is the only
    # signal. This is the guard for the recorded ERR_DLOPEN_FAILED failure mode
    # under pnpm + alpine + standalone.
    ct="$(curl --fail --silent -H 'Accept: image/webp' -o /dev/null \
        -w '%{content_type}' \
        'http://localhost:3000/_next/image?url=%2Fgithub-mark-white.png&w=32&q=75')"
    [ "$ct" = "image/webp" ] \
        || fail "/_next/image returned '$ct', expected image/webp (sharp is broken)"
    echo "OK  /_next/image -> image/webp (sharp works)"

    # Second run, different address. If the URL were baked at build time this
    # would still report the first value.
    docker rm -f smoke-client >/dev/null 2>&1 || true
    CONTAINERS=()
    run smoke-client2 3000 -e SOCKET_URL=https://signal.example.test
    wait_for http://localhost:3000/ || fail "client never served / on the second run"

    cfg2="$(curl --fail --silent http://localhost:3000/api/config)"
    [ "$cfg2" = '{"socketUrl":"https://signal.example.test"}' ] \
        || fail "/api/config was $cfg2 on the second run, so the URL is baked, not runtime"
    echo "OK  /api/config follows a changed SOCKET_URL with no rebuild"
    ;;

*)
    fail "unknown image name '$NAME'"
    ;;
esac

echo "SMOKE PASS: $NAME"
