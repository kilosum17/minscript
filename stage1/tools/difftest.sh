#!/usr/bin/env bash
# Differential test: stage 0 (../minscript, TypeScript) and stage 1 (this compiler) must produce the
# same output on every .ms file in the repository: the token dumps (lexer), the AST dumps (parser), the
# resolution dumps (resolver), the type dumps (checker), the ownership diagnostics and the HIR dumps
# (lowering), with all their diagnostics (from the resolver on, each file is its own package, as with
# stage 0's `ms resolve` / `ms types` / `ms ownership` / `ms hir`); then whole programs: `ms check`,
# `ms js` and `ms run` on every runnable entry, stage 1 itself included; and projects: `ms config`,
# scripts and `ms test`. Run from stage1/: `ms run difftest`.
set -uo pipefail
cd "$(dirname "$0")/.."
out=$(mktemp -d)
# stage 1 is compiled once (by the seed, from the current sources) and run with its own runtime; it
# analyses with stage 0's std (so both compilers see the same prelude), and its `js` output imports
# stage 0's runtime (so the JavaScript compares as text)
node bin/ms1.js js --runtime "file://$(pwd)/runtime/runtime.ts" . > "$out/stage1.mjs" || { echo "the seed can't compile stage 1"; exit 1; }
export MS_STD="$(pwd)/../minscript/std" MS_RUNTIME="$(pwd)/runtime/runtime.ts"
stage0_runtime="file://$(cd ../minscript && pwd)/src/js/runtime.ts"
s1="node $(pwd)/runtime/exec.ts $out/stage1.mjs"
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

compare lexer "ms lex" "$s1 lex"
compare parser "ms parse" "$s1 parse"
compare resolver "ms resolve" "$s1 resolve --prelude ../minscript/std/prelude.ms"
compare checker "ms types" "$s1 types --prelude ../minscript/std/prelude.ms"
compare ownership "ms ownership" "$s1 ownership --prelude ../minscript/std/prelude.ms"
compare lowering "ms hir" "$s1 hir --prelude ../minscript/std/prelude.ms"

# Whole programs (the loader, every pass on every package, the JS back end): `ms check`, `ms js` and
# `ms run` on every runnable entry. (Stage 1 itself isn't an entry any more: it needs its own std,
# which stage 0 doesn't have; its corpus, `ms1 corpus`, compiles and checks it.)
entries="$(ls ../minscript/test/run/*.ms ../minscript/test/programs/*.ms ../minscript/test/packages/*/main.ms ../minscript/test/packages/errors/*/main.ms) ../minscript/test/projects/basic ../minscript/test/projects/plain ../minscript/test/projects/shared ../minscript/test/projects/script_in_eval"
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
compare_programs check-programs "ms check" "$s1 check --std ../minscript/std"
compare_programs js-programs "ms js" "$s1 js --std ../minscript/std --runtime $stage0_runtime"
compare_programs run-programs "ms run" "$s1 run --std ../minscript/std"
# Projects and the commands around them (src/project/): `ms config`, scripts, `ms test`, each typed in
# the folder it is about (scripts and `ms test` look for the project there). Test timings are
# normalized. Stage 1 finds std through MS_STD (above), so a script's own `--` arguments reach it untouched.
commands=(
    "../minscript/test/projects/basic|config"
    "../minscript/test/projects/basic|run"
    "../minscript/test/projects/basic|run hello -- a \"it's\""
    "../minscript/test/projects/basic|hello -- x"
    "../minscript/test/projects/basic|run gen"
    "../minscript/test/projects/basic|run check -- --verbose"
    "../minscript/test/projects/basic|run nope"
    "../minscript/test/projects/basic|test"
    "../minscript/test/projects/basic|check"
    "../minscript/test/projects/script_in_eval|config"
    "../minscript/test/projects/plain|config"
    "../minscript/test/projects/plain|run"
    "../minscript|test std test/prelude test/projects"
    "../minscript|test test/testing/failing"
    "../minscript|test test/testing/failing --run passes --reporter dots"
)
: > "$out/projects.0.all"; : > "$out/projects.1.all"
for entry in "${commands[@]}"; do
    dir=${entry%%|*} cmd=${entry#*|}
    for s in 0 1; do
        if [ $s -eq 0 ]; then run="ms $cmd"; else run="$s1 $cmd"; fi
        { echo "== ($dir) $cmd"; (cd "$dir" && eval "timeout 600 $run" 2>&1 | sed -E 's/\([0-9]+ ms\)/(… ms)/'; echo "exit ${PIPESTATUS[0]}"); } >> "$out/projects.$s.all"
    done
done
if diff -u "$out/projects.0.all" "$out/projects.1.all" > "$out/projects.diff"; then
    echo "projects: ${#commands[@]} commands, identical ($(wc -l < "$out/projects.0.all") lines)"
else
    echo "projects: outputs differ:"
    head -30 "$out/projects.diff"
    status=1
fi
[ $status -eq 0 ] && rm -r "$out" || echo "(outputs kept in $out)"
exit $status
