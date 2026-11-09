// JS code generation from HIR (spec §14.2), ported from minscript/src/js/emit.ts. The output is an
// ES module that imports the runtime (minscript/src/js/runtime.ts, shared with stage 0) as `$rt` and
// exports `$main()`.
//
// MinScript has block / if / match expressions and JS doesn't, so the emitter has two modes:
// - `expr(e)` returns a JS expression, first emitting any statements it needs into the current block;
// - `into(e, target)` compiles `e` as statements, then discards its value, assigns it, or returns it.
// When a later argument needs statements, earlier (impure) arguments are spilled to temporaries first,
// so evaluation stays left to right. Every `break` / `continue` is labelled, so the emitter's own
// loops (`select`, `continue` with a step) never capture them.
//
// Stage 0 captures the statements a callback emits (`capture(fn)`); here `begin()` / `end(saved)`
// bracket the code instead (closures that mutate `this` are awkward under the ownership rules).
package js

import "app.lexer.{Span, js_number, json_quote}"
import "app.resolve.{Sym}"
import "app.check.{Ty, VarState, prune_ty, strip_ty, pruned, stripped, tag, is_int, is_float, is_prim}"
import "app.hir.*"

/// Where an expression's value goes: "discard", "assign" (to `name`) or "return".
type Target = r{ kind: string, name: string }

fun discard() -> Target { r{ kind: "discard", name: "" } }
fun ret_target() -> Target { r{ kind: "return", name: "" } }
fun assign_to(name: &str) -> Target { r{ kind: "assign", name: name.to_str() } }

type LoopCtx = { hir: string?, js: string, body: string?, target: string? }

fun reserved(name: &str) -> bool {
    match name {
        "break" | "case" | "catch" | "class" | "const" | "continue" | "debugger" | "default" | "delete" | "do" | "else" | "enum" | "export" => true
        "extends" | "false" | "finally" | "for" | "function" | "if" | "import" | "in" | "instanceof" | "new" | "null" | "return" | "super" => true
        "switch" | "this" | "throw" | "true" | "try" | "typeof" | "var" | "void" | "while" | "with" | "yield" | "let" | "static" | "await" => true
        "implements" | "interface" | "package" | "private" | "protected" | "public" | "arguments" | "eval" | "undefined" | "NaN" | "Infinity" => true
        _ => false
    }
}

fun is_word(c: int) -> bool { (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 || c == 36 }

fun is_digits(s: &str) -> bool {
    if s.is_empty() {
        return false
    }
    for c in s.bytes().iter() {
        if c < 48 || c > 57 {
            return false
        }
    }
    true
}

/// JS's `isPure`: an identifier, a number, a string literal or `undefined` (safe to evaluate twice or late).
fun is_pure(code: &str) -> bool {
    if code == "undefined" || code.is_empty() {
        return code == "undefined"
    }
    let bs = code.bytes()
    let first = bs[0] as int
    // ^[A-Za-z_$][\w$]*$
    if (first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first == 95 || first == 36 {
        return bs.all(#{ b => is_word(b as int) })
    }
    // ^-?\d+(\.\d+)?n?$
    var i = 0
    if first == 45 {
        i = 1
    }
    let start = i
    for i < bs.len() && bs[i] >= 48 && bs[i] <= 57 {
        i += 1
    }
    if i > start {
        if i < bs.len() && bs[i] == 46 {
            let frac = i + 1
            i += 1
            for i < bs.len() && bs[i] >= 48 && bs[i] <= 57 {
                i += 1
            }
            if i == frac {
                return false
            }
        }
        if i < bs.len() && bs[i] == 110 {
            i += 1
        }
        return i == bs.len()
    }
    // ^"([^"\\]|\\.)*"$
    if first == 34 && bs.len() >= 2 {
        var k = 1
        for k < bs.len() - 1 {
            if bs[k] == 92 {
                k += 2
                continue
            }
            if bs[k] == 34 {
                return false
            }
            k += 1
        }
        return k == bs.len() - 1 && bs[bs.len() - 1] == 34
    }
    false
}

fun indent(lines: &Vec[string]) -> Vec[string] {
    var out = [] as Vec[string]
    for l in lines.iter() {
        // most entries are one line: no need to split them
        if !l.contains("\n") {
            out.push(if l.is_empty() { "" } else { "    ${l}" })
            continue
        }
        for part in l.split("\n").iter() {
            out.push(if part.is_empty() { "" } else { "    ${part}" })
        }
    }
    out
}

fun cat(a: Vec[string], b: Vec[string]) -> Vec[string] {
    var out = a
    out.extend(b)
    out
}

fun json_strings(xs: &Vec[string]) -> string { "[${xs.map(#{ x => json_quote(x) }).join(",")}]" }

fun json_ints(xs: &Vec[int]) -> string { "[${xs.map(#{ x => "${x}" }).join(",")}]" }

/// `JSON.stringify` of a shape.
fun shape_json(s: &Shape?) -> string {
    let Some(x) = s else { return "null" }
    match x {
        SStruct(n) => "{\"s\":${json_quote(n)}}"
        SVec(i) => "{\"vec\":${shape_json(unbox(i))}}"
        SOpt(i) => "{\"opt\":${shape_json(unbox(i))}}"
        SMap(i) => "{\"map\":${shape_json(unbox(i))}}"
        SFloat => "{\"f\":true}"
        SI64 => "{\"i64\":true}"
        SPrim(p) => "{\"p\":${json_quote(p)}}"
        SParam(_) => "{\"param\":{}}"
    }
}

/// The text after leading spaces and tabs.
fun after_indent(l: &str) -> string {
    var i = 0
    for i < l.len() && (l.byte_at(i) == 32 || l.byte_at(i) == 9) {
        i += 1
    }
    l.substring(i, l.len()).to_str()
}

fun unbox(x: &Box[Shape]?) -> Shape? {
    match x {
        Some(b) => Some(b.get().clone())
        None => None
    }
}

/// `String(Number(d))` for a decimal integer (exact up to 2^53).
fun number_text(d: &str) -> string {
    let neg = d.starts_with("-")
    let digits = if neg { d.substring(1, d.len()) } else { d }
    var i = 0
    for i < digits.len() - 1 && digits.byte_at(i) == 48 {
        i += 1
    }
    let trimmed = digits.substring(i, digits.len())
    if trimmed.len() <= 15 {
        return if neg && trimmed != "0" { "-${trimmed}" } else { trimmed.to_str() }
    }
    var x = 0.0
    for c in trimmed.bytes().iter() {
        x = x * 10.0 + ((c as int - 48) as f64)
    }
    js_number(if neg { -x } else { x })
}

/// The runtime integer kind of a type: `int` / `isize` are i32 and `usize` is u32 on JS ("" for none).
fun int_kind(t: &Ty, vars: &Vec[VarState]) -> string {
    let s = strip_ty(t, vars)
    if tag(s) != "prim" {
        return ""
    }
    let TyPrim(n) = s else { return "" }
    match n {
        "int" | "isize" | "i32" => "i32"
        "usize" | "u32" => "u32"
        "i8" | "i16" | "u8" | "u16" | "i64" | "u64" => n
        _ => ""
    }
}

/// Arithmetic operators whose integer results are checked or wrapped (spec §9.5).
fun arith(op: &str) -> bool {
    match op {
        "+" | "-" | "*" | "/" | "%" | "<<" | ">>" | "&" | "|" | "^" => true
        _ => false
    }
}

/// An integer operation with its check: overflow panics; bit operations wrap to the width.
fun int_op(op: &str, l: &str, r: &str, k: &str) -> string {
    let big = k == "i64" || k == "u64"
    match op {
        "+" | "-" | "*" => "$rt.ck_${k}(${l} ${op} ${r})"
        "/" => "$rt.ck_${k}(${if big { "$rt.bdiv" } else { "$rt.idiv" }}(${l}, ${r}))"
        "%" => "${if big { "$rt.brem" } else { "$rt.irem" }}(${l}, ${r})"
        "<<" | ">>" => "$rt.shift(${l}, ${r}, \"${op}\", \"${k}\")"
        _ => if k == "u32" { "((${l} ${op} ${r}) >>> 0)" } else { "(${l} ${op} ${r})" }
    }
}

type Emitter = {
    /// the program being emitted and its arenas: read-only, shared (`Ref`s, so nothing is copied)
    program: Ref[Program]
    syms: Ref[Vec[Sym]]
    vars: Ref[Vec[VarState]]
    /// a compiled (non-builtin) function by name → its index in `program.funs`
    user_funs: Map[string, int] = m{}
    out: Vec[string] = []
    names: Map[int, string] = m{}
    used: Set[string] = Set.new()
    temps: int = 0
    loops: Vec[LoopCtx] = []
    labels: int = 0
    globals: Set[string] = Set.new()
    /// the type witnesses of the function being emitted
    witnesses: Vec[int] = []
    // source locations (panic locations): the current function's file, and every `file:line` marked
    file: string?
    last_loc: string = ""
    locs: Vec[string] = []
    loc_index: Map[string, int] = m{}
}

/// `entry`: the function `$main` calls (default `main`).
/// `p` moves in; `syms` and `vars` are the program's arenas (`loader.Program.shared`).
pub fun emit_js(p: Program, syms: Ref[Vec[Sym]], vars: Ref[Vec[VarState]], runtime_url: &str, entry: &str) -> string {
    var e = Emitter { program: Ref(p), syms, vars, file: None }
    let program = e.program
    let prog = program.get()
    var i = 0
    for f in prog.funs.iter() {
        if !f.builtin {
            e.user_funs[f.name.clone()] = i
        }
        i += 1
    }
    for g in prog.globals.iter() {
        let _ = e.globals.insert(g.name.clone())
    }
    e.module(runtime_url, entry)
}

impl Emitter {
    fun strip(&this, t: &Ty) -> Ty { strip_ty(t, this.vars.get()) }
    fun kind_of(&this, t: &Ty) -> string { int_kind(t, this.vars.get()) }

    fun is_big(&this, t: &Ty) -> bool {
        let s = this.strip(t)
        is_prim(s, "i64") || is_prim(s, "u64")
    }

    fun needs_cell(&this, t: &Ty) -> bool {
        match prune_ty(t, this.vars.get()) {
            TyRef { is_mut, .. } => is_mut
            _ => false
        }
    }

    fun witness_var(&this, s: int) -> string { "$w_${this.syms.get()[s].name}${this.syms.get()[s].index}" }

    // ---- module ----

    fun module(&mut this, runtime_url: &str, entry: &str) -> string {
        var lines = ["// Generated by the MinScript compiler. Do not edit.", "import * as $rt from ${json_quote(runtime_url)}", ""]
        // the handle in a local: its borrow is the local's, so `&mut this` calls don't conflict with it
        let program = this.program
        let prog = program.get()
        for f in prog.funs.iter() {
            if !f.builtin {
                lines.extend(this.fun(f))
                lines.push("")
            }
        }
        // std functions written in MinScript: dynamic calls (`$rt.dyn(v, "map")`) find them by name
        var compiled_std = [] as Vec[string]
        for f in prog.funs.iter() {
            if !f.builtin && f.name.starts_with("std.") {
                compiled_std.push("${json_quote(f.name.substring(4, f.name.len()))}: ${this.fn_name(f.name)}")
            }
        }
        if !compiled_std.is_empty() {
            lines.push("$rt.defStd({ ${compiled_std.join(", ")} })")
            lines.push("")
        }
        // the type registry: methods for dynamic dispatch, field names for printing
        for t in prog.types.iter() {
            lines.push(this.type_def(t))
        }
        lines.push("")
        for g in prog.globals.iter() {
            this.reset_fn()
            let code = this.expr(g.value)
            lines.extend(this.out.clone())
            lines.push("const ${this.fn_name(g.name)} = ${code}")
        }
        let call = if this.user_funs.has(entry) { "return await ${this.fn_name(entry)}()" } else { "" }
        lines.push("")
        lines.push("export async function $main() { ${call} }")
        lines.push("")
        // where each statement starts, for panic locations: [JS line, location index] pairs
        let text = lines.join("\n")
        var marks = [] as Vec[int]
        var n = 0
        for l in text.split("\n").iter() {
            n += 1
            let tr = after_indent(l)
            if tr.starts_with("//@") && is_digits(tr.substring(3, tr.len())) {
                marks.push(n)
                marks.push(dec(tr.substring(3, tr.len())))
            }
        }
        "${text}\n$rt.sourceMap(import.meta.url, ${json_strings(this.locs)}, ${json_ints(marks)})\n"
    }

    fun methods_of(&this, owner: &str) -> string {
        var entries = [] as Vec[string]
        let prefix = "${owner}."
        for f in this.program.get().funs.iter() {
            if f.name.starts_with(prefix) {
                let rest = f.name.substring(prefix.len(), f.name.len())
                if !rest.contains(".") {
                    entries.push("${json_quote(rest)}: ${this.fn_name(f.name)}")
                }
            }
        }
        "{ ${entries.join(", ")} }"
    }

    fun type_def(&mut this, t: &HType) -> string {
        match t {
            TDStruct { name, fields, interfaces } => {
                let floats = fields.filter(#{ f => f.float }).map(#{ f => f.name.clone() })
                var shapes = [] as Vec[string]
                for f in fields.iter() {
                    if f.shape.is_some() {
                        shapes.push("${json_quote(f.name)}:${shape_json(f.shape)}")
                    }
                }
                var defaults = [] as Vec[string]
                for f in fields.iter() {
                    let Some(d) = &f.default else { continue }
                    this.reset_fn()
                    let code = this.expr(d)
                    defaults.push("${json_quote(f.name)}: () => { ${this.out.join(" ")} return ${code} }")
                }
                let names = fields.map(#{ f => f.name.clone() })
                "$rt.defType(${json_quote(name)}, \"struct\", ${json_strings(names)}, ${this.methods_of(name)}, ${json_strings(interfaces)}, ${json_strings(floats)}, {${shapes.join(",")}}, { ${defaults.join(", ")} })"
            }
            TDUnion { name, variants, interfaces } => {
                var fields = [] as Vec[string]
                var floats = [] as Vec[string]
                for v in variants.iter() {
                    fields.push("${json_quote(v.name)}:${json_strings(v.fields.map(#{ f => f.name.clone() }))}")
                    for f in v.fields.iter() {
                        if f.float {
                            floats.push("${v.name}.${f.name}")
                        }
                    }
                }
                "$rt.defType(${json_quote(name)}, \"union\", {${fields.join(",")}}, ${this.methods_of(name)}, ${json_strings(interfaces)}, ${json_strings(floats)})"
            }
            TDInter { name, .. } => "$rt.defInter(${json_quote(name)}, ${this.methods_of(name)})"
        }
    }

    fun reset_fn(&mut this) {
        this.witnesses = []
        this.out = []
        this.names = m{}
        this.used = Set.new()
        this.temps = 0
        this.loops = []
        this.labels = 0
    }

    fun fun(&mut this, f: &HFun) -> Vec[string] {
        this.reset_fn()
        this.file = f.file.clone()
        this.last_loc = ""
        var params = [] as Vec[string]
        var prologue = [] as Vec[string]
        var cells = [] as Vec[string]
        if let Some(r) = &f.recv {
            params.push(this.local(r.sym, r.name))
        }
        for p in f.params.iter() {
            let name = this.local(p.sym, p.name)
            if this.needs_cell(p.ty) {
                let cell = "$c_${name}"
                params.push(cell.clone())
                prologue.push("let ${name} = ${cell}.v")
                cells.push("${cell}.v = ${name}")
            } else {
                params.push(name)
            }
        }
        // type witnesses: hidden parameters, after the others (spec §14.1)
        this.witnesses = f.witnesses.clone()
        for w in f.witnesses.iter() {
            params.push(this.witness_var(w))
        }
        let is_async = f.is_async || f.name == "main"
        let head = "function ${this.fn_name(f.name)}(${params.join(", ")})"
        let Some(b) = &f.body else {
            return ["${head} { $rt.panic(${json_quote("extern function `${f.name}` is not available on the JS back end")}) }"]
        }
        this.out = []
        this.block_into(b, ret_target())
        let body = if cells.is_empty() {
            this.out.clone()
        } else {
            var lines = prologue
            lines.push("try {")
            lines.extend(indent(this.out))
            lines.push("} finally { ${cells.join("; ")} }")
            lines
        }
        // an async function is a task: its awaits check whether it was cancelled (spec §9.6)
        if is_async {
            var lines = ["${head} {", "    return $rt.task(async ($task) => {"]
            lines.extend(indent(indent(body)))
            lines.push("    })")
            lines.push("}")
            return lines
        }
        var lines = ["${head} {"]
        lines.extend(indent(body))
        lines.push("}")
        lines
    }

    // ---- names ----

    fun local(&mut this, sym: int, display: &str) -> string {
        if let Some(known) = this.names.get(sym) {
            return known
        }
        let raw = if sym >= 0 && this.syms.get()[sym].kind == "this" { "self" } else { display.to_str() }
        var base = ""
        for c in raw.chars() {
            let code = c as int
            if code < 128 && is_word(code) {
                base += c.to_str()
            } else {
                base += if code >= 0x10000 { "__" } else { "_" }
            }
        }
        if reserved(base) {
            base += "_"
        }
        var name = base.clone()
        var n = 2
        for this.used.has(name) {
            name = "${base}_${n}"
            n += 1
        }
        let _ = this.used.insert(name.clone())
        this.names[sym] = name.clone()
        name
    }

    fun tmp(&mut this, prefix: &str) -> string {
        this.temps += 1
        var name = "${prefix}${this.temps}"
        for this.used.has(name) {
            this.temps += 1
            name = "${prefix}${this.temps}"
        }
        let _ = this.used.insert(name.clone())
        name
    }

    /// A compiled function or global is a local identifier; anything else in std is the runtime's.
    fun fn_name(&this, name: &str) -> string {
        if name.starts_with("std.") && !this.user_funs.has(name) && !this.globals.has(name) {
            return "$rt.std[${json_quote(name.substring(4, name.len()))}]"
        }
        let js = name.replace(".", "$")
        if reserved(js) { "${js}_" } else { js }
    }

    fun is_ctor_name(&this, name: &str) -> bool {
        let last = last_segment(name)
        if last.is_empty() {
            return false
        }
        let c = last.byte_at(0) as int
        c >= 65 && c <= 90 && !this.user_funs.has(name)
    }

    // ---- statement buffers ----

    fun begin(&mut this) -> Vec[string] {
        let saved = this.out.clone()
        this.out = []
        saved
    }

    fun end(&mut this, saved: Vec[string]) -> Vec[string] {
        let got = this.out.clone()
        this.out = saved
        got
    }

    fun emit(&mut this, line: string) { this.out.push(line) }

    fun emit_block(&mut this, head: &str, body: Vec[string]) {
        this.out.push("${head} {")
        this.out.extend(indent(body))
        this.out.push("}")
    }

    fun assign_target(&mut this, target: Target, code: string) {
        match target.kind {
            "discard" => {
                if !is_pure(code) {
                    let wrapped = if code.starts_with("{") || code.starts_with("function") { "(${code})" } else { code }
                    this.emit("${wrapped};")
                }
            }
            "assign" => this.emit("${target.name} = ${code};")
            _ => this.emit("return ${code};")
        }
    }

    /// Evaluates expressions in order, spilling earlier impure ones when a later one needs statements.
    fun exprs(&mut this, list: &Vec[HExpr]) -> Vec[string] {
        var codes = [] as Vec[string]
        for x in list.iter() {
            let mark = this.out.len()
            let c = this.expr(x)
            if this.out.len() > mark {
                var spills = [] as Vec[string]
                var j = 0
                for j < codes.len() {
                    if !is_pure(codes[j]) {
                        let t = this.tmp("$t")
                        spills.push("const ${t} = ${codes[j]};")
                        codes[j] = t
                    }
                    j += 1
                }
                var k = 0
                for s in spills.iter() {
                    this.out.insert(mark + k, s.clone())
                    k += 1
                }
            }
            codes.push(c)
        }
        codes
    }

    // ---- blocks and statements ----

    /// A `//@N` marker before a statement: the runtime maps JS lines back to MinScript (panic locations).
    fun mark(&mut this, span: Span) {
        let Some(file) = &this.file else { return }
        let loc = "${file}:${span.line}"
        if loc == this.last_loc {
            return
        }
        this.last_loc = loc.clone()
        let i = match this.loc_index.get(loc) {
            Some(i) => i
            None => {
                let i = this.locs.len()
                this.locs.push(loc.clone())
                this.loc_index[loc] = i
                i
            }
        }
        this.emit("//@${i}")
    }

    fun block_into(&mut this, b: &HBlock, target: Target) {
        for s in b.stmts.iter() {
            match s {
                HLet { local, value } => {
                    this.mark(value.span)
                    let code = this.expr(value)
                    let name = this.local(local.sym, local.name)
                    this.emit("let ${name} = ${code};")
                }
                HDo(e) => {
                    this.mark(e.span)
                    this.into(e, discard())
                }
            }
        }
        if let Some(v) = &b.value {
            this.mark(v.get().span)
            this.into(v.get(), target)
        }
    }

    /// Compiles `e` as statements; its value goes to `target`.
    fun into(&mut this, e: &HExpr, target: Target) {
        match &e.kind {
            KIf { cond, then, else_block } => {
                let c = this.expr(cond.get())
                let saved = this.begin()
                this.block_into(then, target)
                let then_lines = this.end(saved)
                let Some(eb) = &else_block else {
                    this.emit_block("if (${c})", then_lines)
                    return
                }
                let saved2 = this.begin()
                this.block_into(eb, target)
                let els = this.end(saved2)
                this.out.push("if (${c}) {")
                this.out.extend(indent(then_lines))
                this.out.push("} else {")
                this.out.extend(indent(els))
                this.out.push("}")
            }
            KMatch { .. } => this.match_into(e, target)
            KLoop { .. } => this.loop_into(e, target)
            KBlock(b) => {
                let saved = this.begin()
                this.block_into(b, target)
                let body = this.end(saved)
                this.emit_block("", body)
            }
            KSelect { .. } => this.select_into(e, target)
            KRecover(b) => this.recover_into(b, target)
            KReturn(value) => {
                match value {
                    None => this.emit("return;")
                    Some(v) => {
                        let c = this.expr(v.get())
                        this.emit("return ${c};")
                    }
                }
            }
            KBreak { label, value } => {
                let lp = this.find_loop(label)
                if let Some(v) = value {
                    let c = this.expr(v.get())
                    let t = match &lp {
                        Some(l) => l.target.clone()
                        None => None
                    }
                    match t {
                        Some(name) => this.emit("${name} = ${c};")
                        None => this.assign_target(discard(), c)
                    }
                }
                match lp {
                    Some(l) => this.emit("break ${l.js};")
                    None => this.emit("break;")
                }
            }
            KContinue(label) => {
                match this.find_loop(label) {
                    None => this.emit("continue;")
                    Some(l) => match l.body {
                        Some(b) => this.emit("break ${b};")
                        None => this.emit("continue ${l.js};")
                    }
                }
            }
            KAssign { .. } => this.assign(e)
            KAnd { .. } | KOr { .. } => {
                let code = this.expr(e)
                this.assign_target(target, code)
            }
            _ => {
                let code = this.expr(e)
                this.assign_target(target, code)
            }
        }
    }

    fun find_loop(&this, label: &string?) -> LoopCtx? {
        var i = this.loops.len() - 1
        for i >= 0 {
            let l = &this.loops[i]
            match label {
                None => return Some(l.clone())
                Some(name) => {
                    if l.hir == Some(name.clone()) {
                        return Some(l.clone())
                    }
                }
            }
            i -= 1
        }
        None
    }

    /// A statement-only form used as a value: a temporary receives the value.
    fun via_temp(&mut this, e: &HExpr) -> string {
        let t = this.tmp("$t")
        this.emit("let ${t};")
        this.into(e, assign_to(t))
        t
    }

    // ---- control flow ----

    fun loop_into(&mut this, e: &HExpr, target: Target) {
        let KLoop { label, body, step } = &e.kind else { return }
        if target.kind == "return" {
            let t = this.tmp("$t")
            this.emit("let ${t};")
            this.loop_into(e, assign_to(t))
            this.emit("return ${t};")
            return
        }
        this.labels += 1
        let js = match label {
            Some(l) => "L_${l}_${this.labels}"
            None => "L${this.labels}"
        }
        let body_label = if step.is_some() { Some("${js}_body") } else { None }
        let ctx = LoopCtx { hir: label.clone(), js: js.clone(), body: body_label.clone(), target: if target.kind == "assign" { Some(target.name.clone()) } else { None } }
        this.loops.push(ctx)
        let saved = this.begin()
        if let Some(s) = step {
            let saved_inner = this.begin()
            this.block_into(body, discard())
            let inner = this.end(saved_inner)
            this.emit_block("${body_label ?? ""}:", inner)
            this.block_into(s, discard())
        } else {
            this.block_into(body, discard())
        }
        let lines = this.end(saved)
        this.emit_block("${js}: for (;;)", lines)
        let _ = this.loops.pop()
    }

    fun match_into(&mut this, e: &HExpr, target: Target) {
        let KMatch { subject, arms } = &e.kind else { return }
        var subj = this.expr(subject.get())
        if !is_pure(subj) {
            let s = this.tmp("$s")
            this.emit("const ${s} = ${subj};")
            subj = s
        }
        this.labels += 1
        let label = "M${this.labels}"
        let saved = this.begin()
        for arm in arms.iter() {
            var binds = [] as Vec[string]
            let test = this.test(arm.pattern, subj, binds, subject.get().ty)
            let saved_body = this.begin()
            match &arm.guard {
                Some(g) => {
                    let saved_guard = this.begin()
                    this.into(arm.body, target)
                    this.emit("break ${label};")
                    let guard_lines = this.end(saved_guard)
                    let gc = this.expr(g)
                    this.emit_block("if (${gc})", guard_lines)
                }
                None => {
                    this.into(arm.body, target)
                    this.emit("break ${label};")
                }
            }
            let body = this.end(saved_body)
            let arm_lines = if test == "true" { body } else { cat(cat(["if (${test}) {"], indent(body)), ["}"]) }
            this.emit_block("", if binds.is_empty() { arm_lines } else { cat(["let ${binds.join(", ")};"], arm_lines) })
        }
        this.emit("$rt.panic(\"no match arm matched\", \"Unwrap\");")
        let lines = this.end(saved)
        this.emit_block("${label}:", lines)
    }

    fun select_into(&mut this, e: &HExpr, target: Target) {
        let KSelect { arms, else_expr } = &e.kind else { return }
        let waits = this.exprs(arms.map(#{ a => a.wait.clone() }))
        let sel = this.tmp("$sel")
        this.emit("const ${sel} = new $rt.Selector([${waits.join(", ")}], ${if else_expr.is_some() { "true" } else { "false" }});")
        this.labels += 1
        let label = "S${this.labels}"
        let i = this.tmp("$i")
        let x = this.tmp("$x")
        let saved = this.begin()
        this.emit("const [${i}, ${x}] = await $rt.aw($task, ${sel}.next());")
        var n = 0
        for arm in arms.iter() {
            var binds = [] as Vec[string]
            let test = this.test(arm.pattern, x, binds, TyUnknown)
            let saved_run = this.begin()
            this.emit("${sel}.done(${n});")
            this.into(arm.body, target)
            this.emit("break ${label};")
            let run = this.end(saved_run)
            let lines = if test == "true" { run } else { cat(cat(cat(["if (${test}) {"], indent(run)), ["}"]), ["${sel}.disable(${n});", "continue ${label};"]) }
            this.emit_block("if (${i} === ${n})", if binds.is_empty() { lines } else { cat(["let ${binds.join(", ")};"], lines) })
            n += 1
        }
        if let Some(el) = else_expr {
            let saved_else = this.begin()
            this.into(el.get(), target)
            this.emit("break ${label};")
            let run = this.end(saved_else)
            this.emit_block("if (${i} === -1)", run)
        }
        let body = this.end(saved)
        this.emit_block("${label}: for (;;)", body)
    }

    fun recover_into(&mut this, b: &HBlock, target: Target) {
        let r = this.tmp("$r")
        let v = this.tmp("$v")
        let err = this.tmp("$e")
        this.emit("let ${r};")
        let saved = this.begin()
        this.emit("let ${v};")
        this.block_into(b, assign_to(v))
        this.emit("${r} = $rt.Ok(${v});")
        let body = this.end(saved)
        this.out.push("try {")
        this.out.extend(indent(body))
        this.out.push("} catch (${err}) {")
        this.out.push("    ${r} = $rt.Err($rt.panicValue(${err}));")
        this.out.push("}")
        this.assign_target(target, r)
    }

    // ---- patterns ----

    /// A JS condition testing `subject` against `p`; bindings are assigned inside it (declared in `binds`).
    fun test(&mut this, p: &HPat, subject: &str, binds: &mut Vec[string], ty: &Ty) -> string {
        match p {
            QWild => "true"
            QBind(l) => {
                let name = this.local(l.sym, l.name)
                if !binds.contains(name) {
                    binds.push(name.clone())          // or-patterns bind the same names in every alternative
                }
                "((${name} = ${subject}), true)"
            }
            QLit(v) => {
                if let LUnit = v {
                    return "true"
                }
                "${subject} === ${this.lit_code(v, ty)}"
            }
            QRange { start, end, inclusive } => {
                var parts = [] as Vec[string]
                if let Some(s) = start {
                    parts.push("${subject} >= ${this.lit_code(s, ty)}")
                }
                if let Some(x) = end {
                    parts.push("${subject} ${if inclusive { "<=" } else { "<" }} ${this.lit_code(x, ty)}")
                }
                "(${and_all(parts)})"
            }
            QVariant { variant, fields, .. } => {
                var parts = ["${subject}.$v === ${json_quote(variant)}"]
                var i = 0
                for f in fields.iter() {
                    parts.push(this.test(f, "${subject}.$f[${i}]", binds, TyUnknown))
                    i += 1
                }
                "(${and_all(parts)})"
            }
            QOk(v) => {
                let inner = this.test(v.get(), "${subject}.$f[0]", binds, TyUnknown)
                "(${and_all(["$rt.isOk(${subject})", inner])})"
            }
            QFail(v) => {
                let inner = this.test(v.get(), "${subject}.$f[0]", binds, TyUnknown)
                "(${and_all(["!$rt.isOk(${subject})", inner])})"
            }
            QFields(fs) => {
                var parts = [] as Vec[string]
                for f in fs.iter() {
                    parts.push(this.test(f.pattern, "${subject}.${f.name}", binds, TyUnknown))
                }
                "(${and_all(parts)})"
            }
            QTuple(elems) => {
                let s = this.strip(ty)
                var parts = [] as Vec[string]
                var i = 0
                for el in elems.iter() {
                    let et = match &s {
                        TyTuple(ts) => ts.get(i) ?? TyUnknown
                        _ => TyUnknown
                    }
                    parts.push(this.test(el, "${subject}[${i}]", binds, et))
                    i += 1
                }
                "(${and_all(parts)})"
            }
            QOr(alts) => {
                var parts = [] as Vec[string]
                for x in alts.iter() {
                    parts.push(this.test(x, subject, binds, ty))
                }
                "(${parts.join(" || ")})"
            }
        }
    }

    fun lit_code(&this, v: &HLit, ty: &Ty) -> string {
        match v {
            LUnit => "undefined"
            LBig(d) => if this.is_big(ty) { "${d}n" } else { number_text(d) }
            LNum(x) => if x < 0.0 { "(${js_number(x)})" } else { js_number(x) }
            LStr(s) => json_quote(s)
            LBool(b) => if b { "true" } else { "false" }
        }
    }

    // ---- expressions ----

    fun expr(&mut this, e: &HExpr) -> string {
        match &e.kind {
            KLit(v) => {
                if let LBig(d) = v {
                    let code = if this.is_big(e.ty) { "${d}n" } else { number_text(d) }
                    return if d.starts_with("-") && d != "-0" { "(${code})" } else { code }
                }
                this.lit_code(v, e.ty)
            }
            KChar(c) => json_quote(c)
            KLocal { sym, name } => this.local(sym, name)
            KGlobal(g) => this.fn_name(g)
            KFn(name) => {
                if this.is_ctor_name(name) {
                    let at = last_dot(name)
                    return "$rt.ctor(${json_quote(name.substring(0, at))}, ${json_quote(name.substring(at + 1, name.len()))})"
                }
                this.fn_name(name)
            }
            KCall { .. } => this.call(e)
            KDyncall { recv, method, args } => {
                var all = [recv.get().clone()]
                all.extend(args.clone())
                let codes = this.exprs(all)
                "$rt.dyn(${codes[0]}, ${json_quote(method)}, [${codes.skip(1).join(", ")}])"
            }
            KCallValue { callee, args } => {
                var all = [callee.get().clone()]
                all.extend(args.clone())
                let codes = this.exprs(all)
                let ft = this.strip(callee.get().ty)
                let cell_params = match &ft {
                    TyFn { params, .. } => params.map(#{ p => this.needs_cell(p) })
                    _ => []
                }
                this.call_with_cells("(${codes[0]})", codes.skip(1), args, cell_params)
            }
            KCopy(x) => "$rt.clone(${this.expr(x.get())})"
            KWstatic { witness, method, args } => {
                let codes = this.exprs(args)
                "$rt.wstatic(${this.witness_code(witness)}, ${json_quote(method)}, [${codes.join(", ")}])"
            }
            KExtern { path, args, type_args } => {
                let Some(xs) = &args else { return "$rt.ext(${json_quote(path)})" }
                var codes = this.exprs(xs)
                if let Some(ts) = type_args {
                    codes.push("[${ts.map(#{ t => "{\"s\":${json_quote(t)}}" }).join(",")}]")
                }
                "$rt.ext(${json_quote(path)})(${codes.join(", ")})"
            }
            KStruct { type_name, fields } => {
                let codes = this.exprs(fields.map(#{ f => f.value.clone() }))
                var parts = ""
                var i = 0
                for f in fields.iter() {
                    parts += ", ${json_quote(f.name)}: ${codes[i]}"
                    i += 1
                }
                "({ $t: ${json_quote(type_name)}${parts} })"
            }
            KVariant { union_name, variant, fields } => {
                if union_name == "std.Option" && variant == "None" {
                    return "$rt.None"
                }
                let codes = this.exprs(fields)
                "({ $t: ${json_quote(union_name)}, $v: ${json_quote(variant)}, $f: [${codes.join(", ")}] })"
            }
            KRecord(fields) => {
                let codes = this.exprs(fields.map(#{ f => f.value.clone() }))
                var parts = [] as Vec[string]
                var i = 0
                for f in fields.iter() {
                    parts.push("${json_quote(f.name)}: ${codes[i]}")
                    i += 1
                }
                "({ ${parts.join(", ")} })"
            }
            KTuple(xs) => "$rt.tup([${this.exprs(xs).join(", ")}])"
            KVec(xs) | KArray(xs) => "[${this.elems(xs).join(", ")}]"
            KSet(xs) => "$rt.setOf([${this.elems(xs).join(", ")}])"
            KMap(entries) => {
                var flat = [] as Vec[HExpr]
                for en in entries.iter() {
                    match en {
                        HEntrySpread(x) => flat.push(x.clone())
                        HPair { key, value } => {
                            flat.push(key.clone())
                            flat.push(value.clone())
                        }
                    }
                }
                let codes = this.exprs(flat)
                var i = 0
                var parts = [] as Vec[string]
                for en in entries.iter() {
                    match en {
                        HEntrySpread(_) => {
                            parts.push("...$rt.entries(${codes[i]})")
                            i += 1
                        }
                        HPair { .. } => {
                            parts.push("[${codes[i]}, ${codes[i + 1]}]")
                            i += 2
                        }
                    }
                }
                "$rt.mapOf([${parts.join(", ")}])"
            }
            KRange { start, end, inclusive } => {
                let null_lit = HExpr { ty: TyUnknown, span: e.span, kind: KLit(LUnit) }
                let s = match start {
                    Some(x) => x.get().clone()
                    None => null_lit.clone()
                }
                let en = match end {
                    Some(x) => x.get().clone()
                    None => null_lit
                }
                let codes = this.exprs([s, en])
                "$rt.range(${codes[0]}, ${codes[1]}, ${if inclusive { "true" } else { "false" }})"
            }
            KField { object, name } => {
                let obj = this.expr(object.get())
                if is_digits(name) {
                    return if tag(stripped(object.get().ty, this.vars.get())) == "tuple" { "${obj}[${name}]" } else { "$rt.idx(${obj}, ${name})" }
                }
                "${obj}.${name}"
            }
            KIndex { object, index, map } => {
                let codes = this.exprs([object.get().clone(), index.get().clone()])
                if map { "$rt.mapGet(${codes[0]}, ${codes[1]})" } else { "$rt.at(${codes[0]}, ${codes[1]})" }
            }
            KUnary { op, expr } => {
                let x = this.expr(expr.get())
                let k = this.kind_of(e.ty)
                match op {
                    "neg" => if k != "" { "$rt.ck_${k}(-${x})" } else { "(-${x})" }
                    "not" => "(!${x})"
                    "bitnot" => if k != "" && k != "i32" && k != "i64" { "$rt.wrap(~${x}, \"${k}\")" } else { "(~${x})" }
                    _ => "$rt.panic(\"raw pointers are not available on the JS back end\")"
                }
            }
            KBinary { .. } => this.binary(e)
            KAnd { left, right } | KOr { left, right } => {
                let is_and = match &e.kind {
                    KAnd { .. } => true
                    _ => false
                }
                let l = this.expr(left.get())
                let saved = this.begin()
                let r = this.expr(right.get())
                let stmts = this.end(saved)
                let op = if is_and { "&&" } else { "||" }
                if stmts.is_empty() {
                    return "(${l} ${op} ${r})"
                }
                let t = this.tmp("$t")
                this.emit("let ${t} = ${l};")
                var body = stmts
                body.push("${t} = ${r};")
                this.emit_block("if (${if is_and { t.clone() } else { "!${t}" }})", body)
                t
            }
            KTruthy { expr, .. } => "$rt.isOk(${this.expr(expr.get())})"
            KConcat(parts) => {
                if parts.is_empty() {
                    return "\"\""
                }
                let codes = this.exprs(parts)
                if codes.len() == 1 { codes[0].clone() } else { "(${codes.join(" + ")})" }
            }
            KToStr { expr, shape } => {
                let x = this.expr(expr.get())
                if shape.is_some() {
                    return "$rt.toStrS(${x}, ${this.witness_code(shape)})"
                }
                if is_float(this.strip(expr.get().ty)) { "$rt.toStrF(${x})" } else { "$rt.toStr(${x})" }
            }
            KWiden(x) => "BigInt(${this.expr(x.get())})"
            KCast { .. } => this.cast(e)
            KAwait(x) => "(await $rt.aw($task, ${this.expr(x.get())}))"
            KClosure { .. } => this.closure(e)
            KUnsupported(what) => "$rt.panic(${json_quote("not supported on the JS back end: ${what}")})"
            KAssign { .. } => {
                this.assign(e)
                "undefined"
            }
            _ => this.via_temp(e)
        }
    }

    /// A shape as JS; a generic parameter of this function is its witness parameter (null if it has none).
    fun witness_code(&this, s: &Shape?) -> string {
        match s {
            None => "null"
            Some(SParam(p)) => if this.witnesses.contains(p) { this.witness_var(p) } else { "null" }
            Some(SVec(x)) => "{ vec: ${this.witness_code(unbox(x))} }"
            Some(SOpt(x)) => "{ opt: ${this.witness_code(unbox(x))} }"
            Some(SMap(x)) => "{ map: ${this.witness_code(unbox(x))} }"
            other => shape_json(other)
        }
    }

    fun elems(&mut this, list: &Vec[HElem]) -> Vec[string] {
        let codes = this.exprs(list.map(#{ x => match x {
            HValue(v) => v.clone()
            HSpread(v) => v.clone()
        } }))
        var out = [] as Vec[string]
        var i = 0
        for x in list.iter() {
            out.push(match x {
                HSpread(_) => "...${codes[i]}"
                HValue(_) => codes[i].clone()
            })
            i += 1
        }
        out
    }

    fun call(&mut this, e: &HExpr) -> string {
        let KCall { callee, args, shapes, witness_args } = &e.kind else { return "" }
        var codes = this.exprs(args)
        if let Some(ss) = shapes {
            codes.push("[${ss.map(#{ s => this.witness_code(s) }).join(", ")}]")     // a builtin's type arguments
        }
        var cell_params = [] as Vec[bool]
        if let Some(fi) = this.user_funs.get(callee) {
            // read what the call needs in place (copying the callee would copy its body)
            let witnesses = this.program.get().funs[fi].witnesses.clone()
            let has_recv = this.program.get().funs[fi].recv.is_some()
            let param_tys = this.program.get().funs[fi].params.map(#{ p => p.ty.clone() })
            for w in witnesses.iter() {
                var given: Shape? = None
                var found = false
                for a in witness_args.iter() {
                    let t(s, shape) = a
                    if s == w {
                        given = shape.clone()
                        found = true
                        break
                    }
                }
                codes.push(if found { this.witness_code(given) } else { "null" })
            }
            if has_recv {
                cell_params.push(false)
            }
            for ty in param_tys.iter() {
                cell_params.push(this.needs_cell(ty))
            }
        }
        let name = this.fn_name(callee)
        this.call_with_cells(name, codes, args, cell_params)
    }

    /// Calls `fn`; an argument for a `&mut T` parameter is passed in a cell `{ v }` and written back
    /// after the call, so assignments inside the callee reach the caller's variable.
    fun call_with_cells(&mut this, f: string, args: Vec[string], arg_exprs: &Vec[HExpr], cell_params: Vec[bool]) -> string {
        if !cell_params.any(#{ c => c }) {
            return "${f}(${args.join(", ")})"
        }
        var passed = [] as Vec[string]
        var write_back = [] as Vec[string]
        var i = 0
        for a in args.iter() {
            let cell = cell_params.get(i) ?? false
            if !cell {
                passed.push(a.clone())
                i += 1
                continue
            }
            let c = this.tmp("$cell")
            this.emit("const ${c} = { v: ${a} };")
            passed.push(c.clone())
            if let Some(place) = arg_exprs.get(i) {
                match &place.kind {
                    KLocal { .. } | KField { .. } => write_back.push("${a} = ${c}.v;")
                    _ => {}
                }
            }
            i += 1
        }
        let r = this.tmp("$r")
        this.emit("const ${r} = ${f}(${passed.join(", ")});")
        for w in write_back.iter() {
            this.emit(w.clone())
        }
        r
    }

    fun binary(&mut this, e: &HExpr) -> string {
        let KBinary { op, left, right } = &e.kind else { return "" }
        let codes = this.exprs([left.get().clone(), right.get().clone()])
        let l = codes[0].clone()
        let r = codes[1].clone()
        let lt = this.strip(left.get().ty)
        let rt = this.strip(right.get().ty)
        let big = this.is_big(lt) || this.is_big(rt)
        let k = this.kind_of(e.ty)
        if k != "" && arith(op) {
            return int_op(op, l, r, k)
        }
        if op == "/" {
            if big {
                return "$rt.bdiv(${l}, ${r})"
            }
            if is_int(lt) {
                return "$rt.idiv(${l}, ${r})"
            }
        } else if op == "%" {
            if big {
                return "$rt.brem(${l}, ${r})"
            }
            if is_int(lt) {
                return "$rt.irem(${l}, ${r})"
            }
        } else if op == "==" || op == "!=" {
            let primitive = #{ t: &Ty => tag(t) == "prim" || tag(t) == "lit" || tag(t) == "union" }
            if primitive(lt) && primitive(rt) {
                return "(${l} ${op}= ${r})"
            }
            return if op == "==" { "$rt.eq(${l}, ${r})" } else { "(!$rt.eq(${l}, ${r}))" }
        }
        "(${l} ${op} ${r})"
    }

    fun cast(&mut this, e: &HExpr) -> string {
        let KCast { expr, to } = &e.kind else { return "" }
        let x = this.expr(expr.get())
        let from = this.strip(expr.get().ty)
        let target = this.strip(to)
        if is_prim(from, "char") && is_int(target) {
            return if this.is_big(target) { "BigInt(${x}.codePointAt(0))" } else { "${x}.codePointAt(0)" }
        }
        if is_int(from) && is_prim(target, "char") {
            return "String.fromCodePoint(Number(${x}))"
        }
        let k = this.kind_of(target)
        // integer targets: wrapping from integers, saturating from floats (spec §3.3)
        if k != "" && (is_int(from) || is_float(from)) {
            if this.kind_of(from) == k {
                return x
            }
            return "$rt.toInt(${x}, \"${k}\", ${if is_float(from) { "true" } else { "false" }})"
        }
        if is_float(target) {
            return if this.is_big(from) { "Number(${x})" } else { x }
        }
        x
    }

    fun combine(&this, op: &str, ty: &Ty, cur: &str, v: &str) -> string {
        let bin = op.substring(0, op.len() - 1)
        let k = this.kind_of(ty)
        if k != "" && arith(bin) {
            return int_op(bin, cur, v, k)
        }
        if bin == "/" {
            return if this.is_big(ty) { "$rt.bdiv(${cur}, ${v})" } else if is_int(this.strip(ty)) { "$rt.idiv(${cur}, ${v})" } else { "(${cur} / ${v})" }
        }
        if bin == "%" {
            return if this.is_big(ty) { "$rt.brem(${cur}, ${v})" } else if is_int(this.strip(ty)) { "$rt.irem(${cur}, ${v})" } else { "(${cur} % ${v})" }
        }
        "(${cur} ${bin} ${v})"
    }

    fun assign(&mut this, e: &HExpr) {
        let KAssign { target, op, value } = &e.kind else { return }
        let t = target.get()
        let ty = this.strip(t.ty)
        match &t.kind {
            KIndex { object, index, map } => {
                let codes = this.exprs([object.get().clone(), index.get().clone(), value.get().clone()])
                let o = codes[0].clone()
                let i = codes[1].clone()
                let read = if map { "$rt.mapGet(${o}, ${i})" } else { "$rt.at(${o}, ${i})" }
                let v = if op == "=" { codes[2].clone() } else { this.combine(op, ty, read, codes[2]) }
                this.emit(if map { "${o}.set(${i}, ${v});" } else { "$rt.setAt(${o}, ${i}, ${v});" })
                return
            }
            KUnary { op: uop, .. } => {
                if uop == "deref" {
                    this.emit("$rt.panic(\"raw pointers are not available on the JS back end\");")
                    return
                }
            }
            _ => {}
        }
        var place = ""
        if let KField { object, name } = &t.kind {
            // the object once: `f().x += 1` mustn't call `f` twice
            var obj = this.expr(object.get())
            if op != "=" && !obj.bytes().all(#{ b => is_word(b as int) || b == 46 }) {
                let tmp = this.tmp("$t")
                this.emit("const ${tmp} = ${obj};")
                obj = tmp
            }
            place = if is_digits(name) { "${obj}[${name}]" } else { "${obj}.${name}" }
        } else {
            place = this.expr(t)
        }
        let v = this.expr(value.get())
        if op == "=" {
            this.emit("${place} = ${v};")
            return
        }
        if op == "/=" || op == "%=" || this.kind_of(ty) != "" {
            this.emit("${place} = ${this.combine(op, ty, place, v)};")
            return
        }
        this.emit("${place} ${op} ${v};")
    }

    fun closure(&mut this, e: &HExpr) -> string {
        let KClosure { params, body, .. } = &e.kind else { return "" }
        let ft = this.strip(e.ty)
        var ps = [] as Vec[string]
        var prologue = [] as Vec[string]
        var cells = [] as Vec[string]
        var i = 0
        for p in params.iter() {
            let name = this.local(p.sym, p.name)
            let pt = match &ft {
                TyFn { params: fps, .. } => fps.get(i) ?? p.ty.clone()
                _ => p.ty.clone()
            }
            if this.needs_cell(pt) {
                let cell = "$c_${name}"
                ps.push(cell.clone())
                prologue.push("let ${name} = ${cell}.v;")
                cells.push("${cell}.v = ${name};")
            } else {
                ps.push(name)
            }
            i += 1
        }
        let saved_loops = this.loops.clone()
        this.loops = []
        let saved = this.begin()
        this.block_into(body, ret_target())
        let lines = this.end(saved)
        this.loops = saved_loops
        let inner = if cells.is_empty() {
            lines
        } else {
            var all = prologue
            all.push("try {")
            all.extend(indent(lines))
            all.push("} finally { ${cells.join(" ")} }")
            all
        }
        "((${ps.join(", ")}) => {\n${indent(inner).join("\n")}\n})"
    }
}

fun and_all(parts: Vec[string]) -> string {
    let real = parts.filter(#{ x => x != "true" })
    if real.is_empty() { "true" } else { real.join(" && ") }
}

fun last_dot(s: &str) -> int {
    var at = -1
    var k = 0
    for k < s.len() {
        if s.byte_at(k) == 46 {
            at = k
        }
        k += 1
    }
    at
}

fun last_segment(s: &str) -> string { s.substring(last_dot(s) + 1, s.len()).to_str() }

fun dec(s: &str) -> int {
    var n = 0
    for c in s.bytes().iter() {
        n = n * 10 + (c as int - 48)
    }
    n
}
