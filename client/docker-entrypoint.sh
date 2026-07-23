#!/bin/sh
set -eu

node /app/write-runtime-config.mjs
exec "$@"
