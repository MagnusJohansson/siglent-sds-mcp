#!/bin/sh
# Smoke-test a built Docker image: it must not run as root, and the server
# must start and answer an MCP initialize request with the hardening flags
# the README recommends. No instrument is needed; nothing connects to it.
#
# Usage: scripts/check-image.sh IMAGE
set -eu

image="${1:?usage: $0 IMAGE}"
fail() { echo "::error::$1" >&2; exit 1; }

# The configured user. Empty means root, as does "0" or "root".
user="$(docker image inspect --format '{{.Config.User}}' "$image")"
case "$user" in
  "" | 0 | 0:* | root | root:*) fail "$image runs as root (Config.User is '${user}')." ;;
esac

uid="$(docker run --rm --entrypoint id "$image" -u)"
[ "$uid" != "0" ] || fail "$image runs as UID 0."

request='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check-image","version":"1.0.0"}}}'

# stdin closes after the request, so the server exits once it has replied.
# timeout guards against a server that hangs instead.
reply="$(printf '%s\n' "$request" | timeout 30 docker run --rm -i \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  "$image")" || fail "$image didn't run with --read-only --cap-drop=ALL --security-opt=no-new-privileges."

case "$reply" in
  *'"serverInfo"'*) ;;
  *) fail "$image didn't answer initialize. Output: $reply" ;;
esac

echo "$image: runs as UID $uid ('$user'), answers initialize read-only with no capabilities."
