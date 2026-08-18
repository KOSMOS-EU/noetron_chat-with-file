#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/DIST"

OWNER="${PUSH_ORG:-kosmos-eu}"
PACKAGE="${PACKAGE_NAME:-${APP}-web}"
REPO="${REPO:-$(basename "${GIT_BASE:-}/${PACKAGE}")}"
TAG="${TAG:-$(date +%Y%m%d-%H%M)}"
# PACKAGES_TOKEN for push (GitHub Releases needs contents:write), fallback to PUSH_TOKEN
TOKEN="${PACKAGES_TOKEN:-${PUSH_TOKEN:-${CODEBERG_TOKEN:-}}}"
REGISTRY="${PUSH_REGISTRY:-codeberg}"

# Token fallback
if [ -z "$TOKEN" ] && [ -f ~/.codeberg-token ]; then
    TOKEN="$(cat ~/.codeberg-token)"
fi
: "${TOKEN:?Set PUSH_TOKEN in DIST}"

# Build (skip if already built by worker)
if [ -z "${SKIP_BUILD:-}" ]; then
    bash "$SCRIPT_DIR/build_web.sh"
fi

# ZIP
TMPZIP="/tmp/${PACKAGE}-${TAG}.zip"
rm -f "$TMPZIP"
(cd "$SCRIPT_DIR/dist" && zip -r "$TMPZIP" .)
echo "[zip] $(du -h "$TMPZIP" | cut -f1)"

# Push — registry-specific API
case "$REGISTRY" in
    github)
        # GitHub Packages (npm-style generic not available, use releases)
        UPLOAD_URL="https://uploads.github.com/repos/${OWNER}/${REPO}/releases"
        # Create release
        RELEASE=$(curl -sf -X POST "https://api.github.com/repos/${OWNER}/${REPO}/releases" \
            -H "Authorization: token ${TOKEN}" \
            -H "Content-Type: application/json" \
            -d "{\"tag_name\":\"pkg-${TAG}\",\"name\":\"${PACKAGE} ${TAG}\",\"draft\":false}" 2>/dev/null)
        RELEASE_ID=$(echo "$RELEASE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
        # Upload asset
        curl -sf -X POST "https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${RELEASE_ID}/assets?name=${PACKAGE}.zip" \
            -H "Authorization: token ${TOKEN}" \
            -H "Content-Type: application/zip" \
            --data-binary "@${TMPZIP}"
        echo "=== Pushed: ${PACKAGE}:${TAG} (GitHub Release) ==="
        ;;
    *)
        # Codeberg / Gitea Generic Packages
        REGISTRY_HOST="${REGISTRY}.org"
        [[ "$REGISTRY" == *"."* ]] && REGISTRY_HOST="$REGISTRY"
        UPLOAD_URL="https://${REGISTRY_HOST}/api/packages/${OWNER}/generic/${PACKAGE}/${TAG}/${PACKAGE}.zip"
        echo "[push] $UPLOAD_URL"
        curl -sf -X PUT "$UPLOAD_URL" \
            -H "Authorization: token ${TOKEN}" \
            --upload-file "$TMPZIP"
        # Also push as latest
        LATEST_URL="https://${REGISTRY_HOST}/api/packages/${OWNER}/generic/${PACKAGE}/latest/${PACKAGE}.zip"
        curl -sf -X DELETE "$LATEST_URL" -H "Authorization: token ${TOKEN}" -o /dev/null 2>/dev/null || true
        curl -sf -X PUT "$LATEST_URL" -H "Authorization: token ${TOKEN}" --upload-file "$TMPZIP"
        echo "=== Pushed: ${PACKAGE}:${TAG} ==="
        ;;
esac
