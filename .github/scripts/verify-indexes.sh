#!/usr/bin/env bash
#
# Closes the loop after publishing: proves every released tag is genuinely
# multi-arch and that each platform entry is a digest that was smoke-tested on
# its own architecture.
#
# This replaces, rather than adjusts, the single-arch assertion it grew out of.
# That one compared a tag's digest to the build step's digest. Under a merge,
# imagetools mints a NEW index, so the tag digest equals neither leg digest and
# the old comparison would fail on every run. The meaningful comparison is one
# level down: the CHILD digests a tag offers must be exactly the children the
# smoke tests exercised.
#
# Detection, not prevention. It necessarily runs after the tags moved, so its job
# is to make a bad publish loud instead of silent.
set -euo pipefail

# shellcheck source=.github/scripts/manifest-lib.sh
. "$(dirname "$0")/manifest-lib.sh"

: "${SERVER:?SERVER must be set}"
: "${CLIENT:?CLIENT must be set}"
: "${TAGS_SERVER:?TAGS_SERVER must be set}"
: "${TAGS_CLIENT:?TAGS_CLIENT must be set}"

WANT_PLATFORMS="$(printf 'linux/amd64\nlinux/arm64\n')"

check_image() {
    local name="$1" image="$2" tags="$3" want_children tag got_platforms got_children

    # The children the smoke tests actually ran, rebuilt from the recorded legs.
    want_children="$(
        for platform in amd64 arm64; do
            child_digest "${image}@$(leg_digest "$name" "$platform")" "$platform"
        done | sort
    )"

    while IFS= read -r tag; do
        [ -z "$tag" ] && continue

        got_platforms="$(tag_platforms "$tag")"
        if [ "$got_platforms" != "$WANT_PLATFORMS" ]; then
            echo "::error::${tag} offers [$(tr '\n' ' ' <<< "$got_platforms")], expected linux/amd64 and linux/arm64"
            exit 1
        fi

        got_children="$(tag_child_digests "$tag")"
        if [ "$got_children" != "$want_children" ]; then
            echo "::error::${tag} points at digests that were not the ones smoke-tested"
            echo "  offered:      $(tr '\n' ' ' <<< "$got_children")"
            echo "  smoke-tested: $(tr '\n' ' ' <<< "$want_children")"
            exit 1
        fi

        echo "ok  ${tag}  multi-arch, both platforms smoke-tested"
    done <<< "$tags"
}

check_image server "$SERVER" "$TAGS_SERVER"
check_image client "$CLIENT" "$TAGS_CLIENT"
echo "all tags verified"
