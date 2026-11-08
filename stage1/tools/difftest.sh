#!/usr/bin/env bash
# Differential test: stage 0 (../minscript, TypeScript) and stage 1 (this compiler) must produce the
# same output on every .ms file in the repository: the token dumps (lexer), the AST dumps (parser), the
# resolution dumps (resolver), the type dumps (checker), the ownership diagnostics and the HIR dumps
# (lowering), with all their diagnostics (from the resolver on, each file is its own package, as with
# stage 0's `ms resolve` / `ms types` / `ms ownership` / `ms hir`); then whole programs: `ms check`,
# `ms js` and `ms run` on every runnable entry, stage 1 itself included. Run from stage1/: `ms run difftest`.
set -uo pipefail
cd "$(dirname "$0")/.."
out=$(mktemp -d)
files=$(find ../minscript/std ../minscript/test src -name '*.ms' | sort)
count=$(echo "$files" | wc -l)
status=0

compare() {   # compare <pass> <stage-0 command> <stage-1 command>
    local pass=$1
    # shellcheck disable=SC2086
    $2 $files > "$out/$pass.0.out" 2> "$out/$pass.0.raw"
    # shellcheck disable=SC2086
    $3 $files > "$out/$pass.1.out" 2> "$out/$pass.1.raw"
    # diagnostics name files differently (stage 0: absolute outside the current folder): normalize
    for s in 0 1; do sed -E 's#^[^:]*/(minscript|stage1)/#\1/#' "$out/$pass.$s.raw" > "$out/$pass.$s.err"; done
    if diff -u "$out/$pass.0.out" "$out/$pass.1.out" > "$out/$pass.out.diff" && diff -u "$out/$pass.0.err" "$out/$pass.1.err" > "$out/$pass.err.diff"; then
        echo "$pass: $count files, identical ($(wc -l < "$out/$pass.0.out") lines, $(wc -l < "$out/$pass.0.err") diagnostics)"
    else
        echo "$pass: outputs differ:"
        head -30 "$out/$pass.out.diff" "$out/$pass.err.diff" 2>/dev/null
        status=1
    fi
}

compare lexer "ms lex" "ms run . -- lex"
compare parser "ms parse" "ms run . -- parse"
compare resolver "ms resolve" "ms run . -- resolve --prelude ../minscript/std/prelude.ms"
compare checker "ms types" "ms run . -- types --prelude ../minscript/std/prelude.ms"
compare ownership "ms ownership" "ms run . -- ownership --prelude ../minscript/std/prelude.ms"
compare lowering "ms hir" "ms run . -- hir --prelude ../minscript/std/prelude.ms"

# Whole programs (the loader, every pass on every package, the JS back end): `ms check`, `ms js` and
# `ms run` on every runnable entry, stage 1 itself included (stage 1 compiling stage 1).
entries="$(ls ../minscript/test/run/*.ms ../minscript/test/programs/*.ms ../minscript/test/packages/*/main.ms ../minscript/test/packages/errors/*/main.ms) ../minscript/test/projects/plain ../minscript/test/projects/shared ."
compare_programs() {   # compare_programs <pass> <stage-0 command> <stage-1 command>
    local pass=$1 n=0
    : > "$out/$pass.0.all"; : > "$out/$pass.1.all"
    for e in $entries; do
        n=$((n + 1))
        # shellcheck disable=SC2086
        { echo "== $e"; timeout 300 $2 $e 2>&1; echo "exit $?"; } >> "$out/$pass.0.all"
        # shellcheck disable=SC2086
        { echo "== $e"; timeout 300 $3 $e 2>&1; echo "exit $?"; } >> "$out/$pass.1.all"
    done
    if diff -u "$out/$pass.0.all" "$out/$pass.1.all" > "$out/$pass.diff"; then
        echo "$pass: $n programs, identical ($(wc -l < "$out/$pass.0.all") lines)"
    else
        echo "$pass: outputs differ:"
        head -30 "$out/$pass.diff"
        status=1
    fi
}
compare_programs check-programs "ms check" "ms run . -- check --std ../minscript/std"
compare_programs js-programs "ms js" "ms run . -- js --std ../minscript/std"
compare_programs run-programs "ms run" "ms run . -- run --std ../minscript/std"
[ $status -eq 0 ] && rm -r "$out" || echo "(outputs kept in $out)"
exit $status
