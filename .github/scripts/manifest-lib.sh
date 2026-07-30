#!/usr/bin/env bash
#
# Shared helpers for assembling and checking the multi-arch image indexes.
# Sourced by publish-indexes.sh and verify-indexes.sh.
#
# Terminology, because the digests are easy to confuse:
#   leg digest   what one build job pushed. Already an OCI index (provenance is
#                left on), containing one linux manifest plus attestations.
#   child digest the actual platform image inside a leg index. This is what
#                `docker run` resolves to, so it is what the smoke test exercised.
#   tag digest   what a released tag points at after imagetools merges the legs.
#                It equals NEITHER leg digest, which is why the old
#                "tag digest == build digest" assertion had to be replaced
#                rather than adjusted.

set -euo pipefail

# Reads the digest a build leg recorded. Errors go to stderr so they survive
# command substitution; an "::error::" swallowed into a variable becomes part of
# an image reference and produces a baffling failure much later.
leg_digest() {
    local image="$1" platform="$2" file="digests/${1}-${2}"
    if [ ! -s "$file" ]; then
        echo "::error::no verified digest recorded for ${image} linux/${platform}" >&2
        return 1
    fi
    tr -d '[:space:]' < "$file"
}

# The platform image inside a leg index, which is the artifact the smoke test ran.
#
# Asserts the leg holds exactly ONE linux manifest and that its architecture is
# the expected one. Checking only "one manifest of the arch I asked for" would
# let a leg carrying two architectures through: the native smoke would exercise
# only the host-arch child and the other would be merged into a released tag
# having never been run. That is a one-token edit away for anyone adding a third
# platform, so it is guarded here rather than left to the post-publish check.
child_digest() {
    local ref="$1" want="$2" json linux_count arch child
    json="$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest}}')"

    linux_count="$(jq '[.manifests[]? | select(.platform.os == "linux")] | length' <<< "$json")"
    if [ "$linux_count" != "1" ]; then
        echo "::error::${ref} contains ${linux_count} linux manifests, expected exactly 1" >&2
        return 1
    fi

    arch="$(jq -r '[.manifests[]? | select(.platform.os == "linux")][0].platform.architecture' <<< "$json")"
    if [ "$arch" != "$want" ]; then
        echo "::error::${ref} is linux/${arch}, expected linux/${want}" >&2
        return 1
    fi

    child="$(jq -r '[.manifests[]? | select(.platform.os == "linux")][0].digest' <<< "$json")"
    if [ -z "$child" ] || [ "$child" = "null" ]; then
        echo "::error::could not read the platform digest from ${ref}" >&2
        return 1
    fi
    echo "$child"
}

# Every linux platform a released tag actually offers, one "os/arch" per line.
tag_platforms() {
    docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' \
        | jq -r '.manifests[]? | select(.platform.os == "linux")
                 | "\(.platform.os)/\(.platform.architecture)"' \
        | sort
}

# Every linux child digest a released tag offers, one per line.
tag_child_digests() {
    docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' \
        | jq -r '.manifests[]? | select(.platform.os == "linux") | .digest' \
        | sort
}

# Turns a newline-separated tag list into repeated -t arguments.
tag_args() {
    local tags="$1" out=()
    while IFS= read -r t; do
        [ -n "$t" ] && out+=(-t "$t")
    done <<< "$tags"
    if [ "${#out[@]}" -eq 0 ]; then
        echo "::error::empty tag list" >&2
        return 1
    fi
    printf '%s\n' "${out[@]}"
}
