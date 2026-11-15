#!/bin/sh
# Smoke-test a built Docker image: it must not run as root, must contain no
# setuid or setgid files, and the server must start and answer an MCP
# initialize request with the hardening flags the README recommends. No
# instrument is needed; nothing connects to it.
#
# Usage: scripts/check-image.sh IMAGE
set -eu

image="${1:?usage: $0 IMAGE}"
fail() { echo "::error::$1" >&2; exit 1; }
hardening="--read-only --cap-drop=ALL --security-opt=no-new-privileges"

# The configured user. Empty means root, as does "0" or "root". Other
# spellings of UID 0 are caught by the id check below.
user="$(docker image inspect --format '{{.Config.User}}' "$image")" ||
  fail "Can't inspect $image."
case "$user" in
  "" | 0 | 0:* | root | root:*) fail "$image runs as root (Config.User is '${user}')." ;;
esac

status=0
uid="$(docker run --rm --entrypoint id "$image" -u)" || status=$?
[ "$status" -eq 0 ] || fail "Can't run 'id -u' in $image (exit status $status)."
[ "$uid" != "0" ] || fail "$image runs as UID 0."

status=0
# As root: an unprivileged find can't read every directory.
setuid="$(docker run --rm --user 0 --entrypoint find "$image" / -xdev -perm /6000 -type f)" || status=$?
[ "$status" -eq 0 ] || fail "Can't list setuid/setgid files in $image (exit status $status)."
[ -z "$setuid" ] || fail "$image contains setuid/setgid files: $(echo $setuid)"

request='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check-image","version":"1.0.0"}}}'

# stdin closes after the request, so the server exits once it has replied.
# timeout guards against a server that hangs instead.
status=0
# shellcheck disable=SC2086 # $hardening is a list of flags
reply="$(printf '%s\n' "$request" | timeout 30 docker run --rm -i $hardening "$image")" || status=$?
case "$status" in
  0) ;;
  124) fail "$image timed out after 30 s under $hardening. Output: $reply" ;;
  *) fail "$image exited with status $status under $hardening. Output: $reply" ;;
esac

case "$reply" in
  *'"serverInfo"'*) ;;
  *) fail "$image didn't answer initialize under $hardening. Output: $reply" ;;
esac

echo "$image: runs as UID $uid ('$user'), no setuid/setgid files, answers initialize under $hardening."
