#!/usr/bin/env bash
# Vendor Google's Material Symbols Outlined variable font into public/fonts/.
# Run this once when standing up the PWA, or again to refresh the font.
# Output is committed so the deployed app has zero font dependency on Google.
set -euo pipefail

cd "$(dirname "$0")/.."

URL='https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0&display=block'
# Google serves different CSS per User-Agent; a modern-browser UA gets woff2.
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

mkdir -p public/fonts

CSS=$(curl -fsSA "$UA" "$URL")
WOFF2_URL=$(printf '%s\n' "$CSS" | grep -oE 'https://fonts.gstatic.com[^)]+\.woff2' | head -n1)
if [ -z "$WOFF2_URL" ]; then
  echo "ERROR: could not extract woff2 URL from Google CSS response." >&2
  exit 1
fi

echo "Downloading $WOFF2_URL"
curl -fsSL "$WOFF2_URL" -o public/fonts/material-symbols-outlined.woff2

cat > public/fonts/material-symbols-outlined.css <<'EOF'
@font-face {
  font-family: 'Material Symbols Outlined';
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url('./material-symbols-outlined.woff2') format('woff2');
}
EOF

ls -lh public/fonts/
echo "Vendored Material Symbols. Replace the Google <link> in index.html with:"
echo '  <link rel="stylesheet" href="./fonts/material-symbols-outlined.css" />'
