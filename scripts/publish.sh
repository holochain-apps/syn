#!/usr/bin/env bash
#
# Publish the four syn packages to npm, in dependency order.
#
# npm has no atomic multi-package publish and a published version can never
# be reused, so this script does the next best thing: everything that can
# fail is checked before anything is published, and a run that dies halfway
# can simply be re-run -- packages already on the registry at their target
# version are skipped rather than re-published.
#
# Usage: npm run publish        (or: scripts/publish.sh --dry-run)

set -euo pipefail
cd "$(dirname "$0")/.."

# Dependency order: store and core depend on client, text-editor on core.
PACKAGES=(client store core text-editor)

DRY_RUN=()
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=(--dry-run)

name_of()    { node -p "require('./packages/$1/package.json').name"; }
version_of() { node -p "require('./packages/$1/package.json').version"; }

# Already on the registry at this exact version?
published() { npm view "$1@$2" version >/dev/null 2>&1; }

echo "==> whoami"
npm whoami

echo "==> building"
npm run build:libs

echo "==> preflight"
to_publish=()
for p in "${PACKAGES[@]}"; do
  name=$(name_of "$p")
  version=$(version_of "$p")
  if published "$name" "$version"; then
    echo "    skip    $name@$version (already published)"
  else
    echo "    publish $name@$version"
    to_publish+=("$p")
    # Pack it now: a broken tarball, a missing dist, or a bad manifest
    # should fail here, before the first real publish goes out.
    npm pack -w "$name" --pack-destination /tmp >/dev/null
  fi
done

if [[ ${#to_publish[@]} -eq 0 ]]; then
  echo "==> nothing to do; every package is already published at its current version"
  exit 0
fi

echo "==> publishing"
for p in "${to_publish[@]}"; do
  name=$(name_of "$p")
  echo "--- $name@$(version_of "$p")"
  npm publish -w "$name" --access public "${DRY_RUN[@]}"
done

echo "==> done. Tag the release:"
echo "    git tag -a v$(version_of client) -m 'Release v$(version_of client)' && git push origin v$(version_of client)"
