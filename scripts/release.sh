#!/usr/bin/env bash
# release.sh — bump version, build, package, tag, and push to trigger the
# GitHub Actions publish workflow (.github/workflows/publish.yml).
#
# Usage:
#   ./scripts/release.sh patch      # 0.1.0 → 0.1.1
#   ./scripts/release.sh minor      # 0.1.0 → 0.2.0
#   ./scripts/release.sh major      # 0.1.0 → 1.0.0
#   ./scripts/release.sh 1.2.3      # explicit version
#
# Prerequisites:
#   - VSCE_PAT env var set (for VS Marketplace)
#   - OVSX_PAT env var set (for Open VSX)
#   - git working tree is clean
#   - vsce installed: npm i -g @vscode/vsce
#   - ovsx installed: npm i -g ovsx
#
# The workflow in .github/workflows/publish.yml fires on push of a v* tag and
# runs `vsce publish` + `ovsx publish` using secrets stored in GitHub.
# This script tags and pushes — GitHub Actions does the actual marketplace upload.
# To publish locally without CI, set --local flag (requires PATs in env).

set -euo pipefail

BUMP="${1:-}"
LOCAL=false

# Parse flags
for arg in "$@"; do
  if [[ "$arg" == "--local" ]]; then
    LOCAL=true
  fi
done

if [[ -z "$BUMP" || "$BUMP" == "--local" ]]; then
  echo "Usage: $0 <patch|minor|major|x.y.z> [--local]"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# ── Preflight checks ───────────────────────────────────────────────────────

echo "▶ Checking working tree..."
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "✗ Working tree has uncommitted changes. Commit or stash first."
  exit 1
fi

echo "▶ Checking required tools..."
command -v node  >/dev/null || { echo "✗ node not found"; exit 1; }
command -v npm   >/dev/null || { echo "✗ npm not found"; exit 1; }
command -v vsce  >/dev/null || { echo "⚠ vsce not found — install with: npm i -g @vscode/vsce"; }
command -v ovsx  >/dev/null || { echo "⚠ ovsx not found — install with: npm i -g ovsx"; }
command -v git   >/dev/null || { echo "✗ git not found"; exit 1; }

# ── Version bump ───────────────────────────────────────────────────────────

CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "▶ Current version: $CURRENT_VERSION"

if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW_VERSION="$BUMP"
else
  # Use npm version to compute the new version without committing
  NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version --allow-same-version 2>/dev/null | tr -d 'v')
fi

echo "▶ New version: $NEW_VERSION"

# npm version already wrote package.json if BUMP was patch/minor/major.
# For explicit version, write it now.
if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version >/dev/null
fi

# ── Build ──────────────────────────────────────────────────────────────────

echo "▶ Installing dependencies..."
npm install --silent
(cd webview-ui && npm install --silent)

echo "▶ Building..."
npm run build

echo "▶ Packaging .vsix..."
npm run package
VSIX_FILE="grid-master-${NEW_VERSION}.vsix"

if [[ ! -f "$VSIX_FILE" ]]; then
  # vsce may name it differently if the old version wasn't updated
  VSIX_FILE=$(ls *.vsix 2>/dev/null | head -1)
fi

if [[ -z "$VSIX_FILE" ]]; then
  echo "✗ No .vsix file found after packaging"
  exit 1
fi

echo "✔ Packaged: $VSIX_FILE"

# ── Local publish (optional) ───────────────────────────────────────────────

if [[ "$LOCAL" == "true" ]]; then
  echo "▶ Publishing locally (--local flag set)..."

  if [[ -n "${VSCE_PAT:-}" ]]; then
    echo "  Publishing to VS Marketplace..."
    vsce publish --pat "$VSCE_PAT"
  else
    echo "  ⚠ VSCE_PAT not set — skipping VS Marketplace"
  fi

  if [[ -n "${OVSX_PAT:-}" ]]; then
    echo "  Publishing to Open VSX..."
    ovsx publish "$VSIX_FILE" --pat "$OVSX_PAT"
  else
    echo "  ⚠ OVSX_PAT not set — skipping Open VSX"
  fi
fi

# ── Git tag and push (triggers GitHub Actions publish workflow) ────────────

TAG="v${NEW_VERSION}"

echo "▶ Committing version bump..."
git add package.json package-lock.json
git commit -m "chore: release ${TAG}"

echo "▶ Tagging ${TAG}..."
git tag -a "$TAG" -m "Release ${TAG}"

echo "▶ Pushing commit and tag..."
git push origin HEAD
git push origin "$TAG"

echo ""
echo "✔ Released ${TAG}"
echo ""
echo "GitHub Actions will now publish to VS Marketplace and Open VSX."
echo "Monitor progress at: https://github.com/$(git remote get-url origin | sed 's/.*github.com[:/]//' | sed 's/\.git$//')/actions"
