#!/usr/bin/env bash
# Vendor Inter (variable woff2) into public/fonts/.
# Run this once when standing up the app, or again to refresh the font.
# Output is committed so the deployed PWA has zero font dependency on Google.
set -euo pipefail

cd "$(dirname "$0")/.."

# Inter variable font, weight axis 100..900. Google Fonts serves the
# latin-range woff2 only (no CJK) which is what we want for the UI.
URL='https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap'
# Google serves different CSS per User-Agent; a modern-browser UA gets woff2.
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

mkdir -p public/fonts

CSS=$(curl -fsSA "$UA" "$URL")
# Google splits Inter by unicode-range (cyrillic, greek, latin-ext, latin, ...);
# the Latin range is always the last @font-face block in the response.
# Grab the woff2 URL inside the LAST `src: url(...)` and use it.
WOFF2_URL=$(printf '%s\n' "$CSS" | grep -oE 'https://fonts.gstatic.com[^)]+\.woff2' | tail -n1)
if [ -z "$WOFF2_URL" ]; then
  echo "ERROR: could not extract woff2 URL from Google CSS response." >&2
  exit 1
fi

echo "Downloading $WOFF2_URL"
curl -fsSL "$WOFF2_URL" -o public/fonts/inter.woff2

# Ship the SIL OFL 1.1 license alongside the woff2 — required by the
# license when redistributing the font file. The original LICENSE.txt
# lives in the Inter project's upstream repo.
echo "Downloading Inter SIL OFL license"
curl -fsSL 'https://raw.githubusercontent.com/rsms/inter/master/LICENSE.txt' \
  -o public/fonts/inter-LICENSE.txt

cat > public/fonts/inter.css <<'EOF'
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('./inter.woff2') format('woff2');
}
EOF

ls -lh public/fonts/inter.*
echo "Vendored Inter. The link tag in index.html should be:"
echo '  <link rel="stylesheet" href="./fonts/inter.css" />'
