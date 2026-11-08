#!/usr/bin/env bash
# Differential test: stage 0 (../minscript, TypeScript) and stage 1 (this compiler) must lex every
# .ms file in the repository to the same token dump. Run from stage1/: `ms run difftest`.
set -euo pipefail
cd "$(dirname "$0")/.."
out=$(mktemp -d)
files=$(find ../minscript/std ../minscript/test src -name '*.ms' | sort)
count=$(echo "$files" | wc -l)
# shellcheck disable=SC2086
ms lex $files > "$out/stage0.txt" 2>/dev/null || true
# shellcheck disable=SC2086
ms run . -- lex $files > "$out/stage1.txt"
if diff -u "$out/stage0.txt" "$out/stage1.txt" > "$out/diff.txt"; then
    echo "lexer: $count files, identical dumps"
    rm -r "$out"
else
    echo "lexer: dumps differ (first lines of $out/diff.txt):"
    head -40 "$out/diff.txt"
    exit 1
fi
