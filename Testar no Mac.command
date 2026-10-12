#!/bin/bash
# Oggi Pedidos - teste local (Mac)
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Falta instalar o Node.js, o programa que faz o sistema funcionar."
  echo "Vou abrir o site. Baixe a versão LTS, instale e depois abra de novo este arquivo."
  open "https://nodejs.org/pt"
  read -r -p "Aperte Enter para fechar."
  exit 1
fi

if [ ! -d node_modules/better-sqlite3 ]; then
  echo "Instalando o sistema. Isso acontece só na primeira vez e leva alguns minutos..."
  if ! npm install --omit=dev --no-audit --no-fund --loglevel=error; then
    echo ""
    echo "Algo deu errado na instalação. Tire um print desta janela e mande para o Claude."
    read -r -p "Aperte Enter para fechar."
    exit 1
  fi
fi

node scripts/teste-local.js
