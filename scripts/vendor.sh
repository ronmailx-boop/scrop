#!/bin/sh
# Copies the browser builds of the bundled libraries into public/vendor (no CDN).
set -e
cd "$(dirname "$0")/.."
V=public/vendor
mkdir -p "$V"
strip() { sed '/sourceMappingURL=/d' "$1" > "$2"; }
strip node_modules/pdfjs-dist/build/pdf.min.mjs "$V/pdf.min.mjs"
strip node_modules/pdfjs-dist/build/pdf.worker.min.mjs "$V/pdf.worker.min.mjs"
strip node_modules/pdf-lib/dist/pdf-lib.esm.min.js "$V/pdf-lib.esm.min.js"
strip node_modules/fflate/esm/browser.js "$V/fflate.mjs"
cp node_modules/pdfjs-dist/LICENSE "$V/pdfjs.LICENSE.txt"
cp node_modules/pdf-lib/LICENSE.md "$V/pdf-lib.LICENSE.md"
cp node_modules/fflate/LICENSE "$V/fflate.LICENSE.txt"
