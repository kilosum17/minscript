#!/usr/bin/env bash
# Rebuilds the seed (seed/stage1.mjs): stage 1 compiled by stage 1, which `bin/ms1.js` runs, so stage 1
# needs no other compiler. The current seed compiles the sources; the result must then compile the
# sources to itself (a fixpoint), or the seed is left as it was. Without a seed (the first time),
# stage 0 compiles stage 1 to start from. Run from stage1/: `ms1 run reseed` (or `ms run reseed`).
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
runtime="../../minscript/src/js/runtime.ts"      # relative to seed/, where the seed runs
std="$(pwd)/../minscript/std"
if [ -f seed/stage1.mjs ]; then
    builder=(node bin/ms1.js)
else
    echo "no seed yet: stage 0 compiles stage 1 first"
    (cd ../minscript && node src/cli.ts js ../stage1) > "$tmp/stage0.mjs"
    builder=(node ../minscript/src/js/exec.ts "$tmp/stage0.mjs")
fi
MS_STD="$std" "${builder[@]}" js --runtime "$runtime" . > "$tmp/next.mjs"
cp "$tmp/next.mjs" seed/next.mjs
MS_STD="$std" MS1_SEED="$(pwd)/seed/next.mjs" node bin/ms1.js js --runtime "$runtime" . > "$tmp/again.mjs"
rm seed/next.mjs
if ! cmp -s "$tmp/next.mjs" "$tmp/again.mjs"; then
    echo "the new seed doesn't compile stage 1 to itself; the seed is unchanged" >&2
    diff "$tmp/next.mjs" "$tmp/again.mjs" | head -20 >&2
    exit 1
fi
mv "$tmp/next.mjs" seed/stage1.mjs
echo "seed/stage1.mjs: $(wc -l < seed/stage1.mjs) lines (a fixpoint)"
