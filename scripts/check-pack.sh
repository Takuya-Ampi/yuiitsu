#!/usr/bin/env bash
# 公開対象パッケージの tarball を作り、package.json に workspace: が残っていないことを確認する。
# pnpm pack / pnpm publish は workspace:^ を実バージョンに置換する。npm publish はしない。
set -euo pipefail
cd "$(dirname "$0")/.."

tmp="$(mktemp -d -t yuiitsu-pack.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

status=0
for dir in packages/*/; do
  if [ "$(node -p "Boolean(require('./${dir}package.json').private)")" = "true" ]; then
    continue
  fi
  (cd "$dir" && pnpm pack --pack-destination "$tmp" >/dev/null)
done

for tgz in "$tmp"/*.tgz; do
  manifest="$(tar -xzOf "$tgz" package/package.json)"
  name="$(node -p "JSON.parse(process.argv[1]).name" "$manifest")"
  if grep -q 'workspace:' <<<"$manifest"; then
    echo "NG: $name に workspace: が残っている" >&2
    status=1
  else
    echo "OK: $name $(node -p "JSON.parse(process.argv[1]).peerDependencies?.['@yuiitsu/core'] ?? '-'" "$manifest")"
  fi
done
exit "$status"
