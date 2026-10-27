#!/usr/bin/env bash
# Baixa para gestao/public/vendor as bibliotecas que ainda vêm da CDN e mostra o hash SHA-384 de cada uma.
# Rode num computador com internet, na raiz do repositório:  bash gestao/baixar-bibliotecas.sh
# Depois confira os hashes (anote no histórico do repositório), faça commit e implante.
set -euo pipefail
cd "$(dirname "$0")/public/vendor"
baixar(){ mkdir -p "$(dirname "$1")"; curl -fsSL --proto '=https' --tlsv1.2 -o "$1.parcial" "$2"; mv "$1.parcial" "$1"; printf '%-38s sha384-%s\n' "$1" "$(openssl dgst -sha384 -binary "$1" | openssl base64 -A)"; }
baixar xlsx/xlsx.full.min.js           https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
baixar html2canvas/html2canvas.min.js  https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
baixar jspdf/jspdf.umd.min.js          https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js
baixar pdflib/pdf-lib.min.js           https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js
grep -q "SheetJS" xlsx/xlsx.full.min.js && head -c 300 xlsx/xlsx.full.min.js | grep -o 'version[^,;]*' | head -1 || true
echo "Pronto. Faça commit de gestao/public/vendor e implante o serviço gestao."
