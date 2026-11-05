#!/usr/bin/env bash
# Baixa pelo npm, nas versões que o sistema usa (a de Excel já na 0.20.3, corrigida), as bibliotecas do navegador que ainda vêm da CDN e copia para
# gestao/public/vendor. Mostra o hash SHA-384 de cada arquivo. (v157: antes baixava direto da CDN.)
# Rode num computador com Node e internet, na raiz do repositório:  bash gestao/baixar-bibliotecas.sh
# Depois confira os hashes (anote no histórico do repositório), faça commit e implante.
set -euo pipefail
VEND="$(cd "$(dirname "$0")/public/vendor" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# pacote@versão  arquivo dentro do pacote  destino em public/vendor
LISTA=(
  "jspdf@2.5.1 dist/jspdf.umd.min.js jspdf/jspdf.umd.min.js"
  # SheetJS 0.20.3 (corrige CVE-2023-30533 e CVE-2024-22363); não está no npm, vem do site oficial da SheetJS
  "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz dist/xlsx.full.min.js xlsx/xlsx.full.min.js"
  "html2canvas@1.4.1 dist/html2canvas.min.js html2canvas/html2canvas.min.js"
  "pdf-lib@1.17.1 dist/pdf-lib.min.js pdflib/pdf-lib.min.js"
)
for item in "${LISTA[@]}"; do
  read -r pac arq dest <<<"$item"
  (cd "$TMP" && npm pack --silent "$pac" >/dev/null)
  tgz="$(ls "$TMP"/*.tgz)"; mkdir -p "$TMP/x"; tar -xzf "$tgz" -C "$TMP/x"
  mkdir -p "$VEND/$(dirname "$dest")"; cp "$TMP/x/package/$arq" "$VEND/$dest"
  [ -f "$TMP/x/package/LICENSE" ] && cp "$TMP/x/package/LICENSE" "$VEND/$(dirname "$dest")/LICENSE" || true
  [ -f "$TMP/x/package/LICENSE.md" ] && cp "$TMP/x/package/LICENSE.md" "$VEND/$(dirname "$dest")/LICENSE.md" || true
  echo "$pac ($arq)" > "$VEND/$(dirname "$dest")/VERSAO.txt"
  printf '%-40s sha384-%s\n' "$dest" "$(openssl dgst -sha384 -binary "$VEND/$dest" | openssl base64 -A)"
  rm -rf "$TMP/x" "$tgz"
done
echo "Pronto. Faça commit de gestao/public/vendor e implante o serviço gestao."
