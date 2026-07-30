#!/bin/sh
# Sert le repo pour la démo. `--cors` autorise le chargement d'un MKV depuis une
# autre origine ; `-s` coupe le journal d'accès (une lecture = des centaines de
# requêtes Range, illisible autrement).
cd "$(dirname "$0")/.." || exit 1
npm run build && npx --yes http-server -p 8899 -s --cors .
