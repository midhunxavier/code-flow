#!/bin/sh
set -eu
umask 077
source_dir=$1
bundle_id=$2
desktop_id=$3
arch=$4
node_sha=$5
case "$bundle_id:$desktop_id:$node_sha" in *[!a-f0-9:]*) echo 'Invalid desktop runtime identity' >&2; exit 1;; esac
[ "${#bundle_id}" -eq 64 ] && [ "${#desktop_id}" -eq 16 ] && [ "${#node_sha}" -eq 64 ]
case "$arch:$(uname -m)" in x64:x86_64|arm64:aarch64) ;; *) echo 'The bundled Node architecture does not match this distribution.' >&2; exit 1;; esac
base="$HOME/.local/share/code-flow/desktop/$desktop_id/versions"
destination="$base/$bundle_id"
mkdir -p "$base"
if [ ! -f "$destination/.complete" ]; then
  actual_sha=$(sha256sum "$source_dir/wsl/node-linux.tar.gz")
  [ "${actual_sha%% *}" = "$node_sha" ] || { echo 'Bundled Node checksum mismatch.' >&2; exit 1; }
  scratch=$(mktemp -d "$base/.install-XXXXXX")
  trap 'rm -rf "$scratch"' EXIT HUP INT TERM
  mkdir -p "$scratch/node" "$scratch/backend"
  tar -xzf "$source_dir/wsl/node-linux.tar.gz" --strip-components=1 -C "$scratch/node"
  cp -R "$source_dir/backend/." "$scratch/backend/"
  cp "$source_dir/wsl/runner.cjs" "$scratch/runner.cjs"
  chmod 700 "$scratch/node/bin/node"
  touch "$scratch/.complete"
  mv "$scratch" "$destination"
  trap - EXIT HUP INT TERM
fi
printf 'CODEFLOW_WSL_RUNTIME\000%s\000%s\000' "$destination/node/bin/node" "$destination/runner.cjs"
