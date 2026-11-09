// Structural checks on lowered HIR, ported from minscript/src/hir_check.ts and used by the corpus:
// every local is bound before use (by a parameter, `let`, pattern, closure parameter or capture),
// every `break` / `continue` label names an enclosing loop, `break` / `continue` only occur inside
// loops, and nothing is `unsupported`. A failure here is a bug in lowering, not in the program.
package hir

import "app.lexer.{Span}"

pub fun validate_hir(p: &Program) -> Vec[string] {
    var problems = [] as Vec[string]
    for f in p.funs.iter() {
        let Some(body) = &f.body else { continue }
        var scope = Set.new() as Set[int]
        for x in f.params.iter() {
            let _ = scope.insert(x.sym)
        }
        if let Some(r) = &f.recv {
            let _ = scope.insert(r.sym)
        }
        var v = Validator { place: f.name.clone() }
        v.block(body, scope, [], false)
        problems.extend(v.problems)
    }
    for g in p.globals.iter() {
        var v = Validator { place: "global ${g.name}" }
        v.expr(g.value, Set.new(), [], false)
        problems.extend(v.problems)
    }
    problems
}

type Validator = { place: string, problems: Vec[string] = [] }

impl Validator {
    fun report(&mut this, msg: string, span: Span) {
        this.problems.push("${this.place} ${span.line}:${span.col}: ${msg}")
    }

    fun block(&mut this, b: &HBlock, outer: &Set[int], labels: &Vec[string?], in_loop: bool) {
        var scope = outer.clone()
        for s in b.stmts.iter() {
            match s {
                HLet { local, value } => {
                    this.expr(value, scope, labels, in_loop)
                    let _ = scope.insert(local.sym)
                }
                HDo(x) => this.expr(x, scope, labels, in_loop)
            }
        }
        if let Some(v) = &b.value {
            this.expr(v.get(), scope, labels, in_loop)
        }
    }

    fun binds(&this, p: &HPat, into: &mut Set[int]) {
        match p {
            QBind(l) => {
                let _ = into.insert(l.sym)
            }
            QVariant { fields, .. } => {
                for f in fields.iter() {
                    this.binds(f, into)
                }
            }
            QFields(fs) => {
                for f in fs.iter() {
                    this.binds(f.pattern, into)
                }
            }
            QTuple(es) => {
                for x in es.iter() {
                    this.binds(x, into)
                }
            }
            QOr(alts) => {
                if let Some(first) = alts.get(0) {
                    this.binds(first, into)
                }
            }
            QOk(x) | QFail(x) => this.binds(x.get(), into)
            _ => {}
        }
    }

    fun all(&mut this, xs: &Vec[HExpr], scope: &Set[int], labels: &Vec[string?], in_loop: bool) {
        for x in xs.iter() {
            this.expr(x, scope, labels, in_loop)
        }
    }

    fun elems(&mut this, xs: &Vec[HElem], scope: &Set[int], labels: &Vec[string?], in_loop: bool) {
        for x in xs.iter() {
            match x {
                HValue(v) | HSpread(v) => this.expr(v, scope, labels, in_loop)
            }
        }
    }

    fun expr(&mut this, e: &HExpr, scope: &Set[int], labels: &Vec[string?], in_loop: bool) {
        match &e.kind {
            KLocal { sym, name } => {
                if !scope.has(sym) {
                    this.report("`${name}` is used but not bound", e.span)
                }
            }
            KUnsupported(what) => this.report("unsupported: ${what}", e.span)
            KContinue(label) => this.check_jump(label, labels, in_loop, e.span)
            KLit(_) | KChar(_) | KGlobal(_) | KFn(_) => {}
            KCall { args, .. } | KWstatic { args, .. } | KTuple(args) | KConcat(args) => this.all(args, scope, labels, in_loop)
            KVariant { fields, .. } => this.all(fields, scope, labels, in_loop)
            KDyncall { recv, args, .. } => {
                this.expr(recv.get(), scope, labels, in_loop)
                this.all(args, scope, labels, in_loop)
            }
            KCallValue { callee, args } => {
                this.expr(callee.get(), scope, labels, in_loop)
                this.all(args, scope, labels, in_loop)
            }
            KExtern { args, .. } => {
                if let Some(xs) = args {
                    this.all(xs, scope, labels, in_loop)
                }
            }
            KCopy(x) | KWiden(x) | KAwait(x) => this.expr(x.get(), scope, labels, in_loop)
            KStruct { fields, .. } | KRecord(fields) => {
                for f in fields.iter() {
                    this.expr(f.value, scope, labels, in_loop)
                }
            }
            KVec(xs) | KArray(xs) | KSet(xs) => this.elems(xs, scope, labels, in_loop)
            KMap(entries) => {
                for x in entries.iter() {
                    match x {
                        HPair { key, value } => {
                            this.expr(key, scope, labels, in_loop)
                            this.expr(value, scope, labels, in_loop)
                        }
                        HEntrySpread(v) => this.expr(v, scope, labels, in_loop)
                    }
                }
            }
            KRange { start, end, .. } => {
                if let Some(x) = start {
                    this.expr(x.get(), scope, labels, in_loop)
                }
                if let Some(x) = end {
                    this.expr(x.get(), scope, labels, in_loop)
                }
            }
            KField { object, .. } => this.expr(object.get(), scope, labels, in_loop)
            KIndex { object, index, .. } => {
                this.expr(object.get(), scope, labels, in_loop)
                this.expr(index.get(), scope, labels, in_loop)
            }
            KUnary { expr, .. } | KTruthy { expr, .. } | KToStr { expr, .. } | KCast { expr, .. } => this.expr(expr.get(), scope, labels, in_loop)
            KBinary { left, right, .. } | KAnd { left, right } | KOr { left, right } => {
                this.expr(left.get(), scope, labels, in_loop)
                this.expr(right.get(), scope, labels, in_loop)
            }
            KAssign { target, value, .. } => {
                this.expr(target.get(), scope, labels, in_loop)
                this.expr(value.get(), scope, labels, in_loop)
            }
            KIf { cond, then, else_block } => {
                this.expr(cond.get(), scope, labels, in_loop)
                this.block(then, scope, labels, in_loop)
                if let Some(eb) = else_block {
                    this.block(eb, scope, labels, in_loop)
                }
            }
            KMatch { subject, arms } => {
                this.expr(subject.get(), scope, labels, in_loop)
                for a in arms.iter() {
                    var s = scope.clone()
                    this.binds(a.pattern, s)
                    if let Some(g) = &a.guard {
                        this.expr(g, s, labels, in_loop)
                    }
                    this.expr(a.body, s, labels, in_loop)
                }
            }
            KLoop { label, body, step } => {
                var inner = labels.clone()
                inner.push(label.clone())
                this.block(body, scope, inner, true)
                if let Some(st) = step {
                    this.block(st, scope, inner, true)
                }
            }
            KBreak { label, value } => {
                this.check_jump(label, labels, in_loop, e.span)
                if let Some(v) = value {
                    this.expr(v.get(), scope, labels, in_loop)
                }
            }
            KReturn(v) => {
                if let Some(x) = v {
                    this.expr(x.get(), scope, labels, in_loop)
                }
            }
            KBlock(b) | KRecover(b) => this.block(b, scope, labels, in_loop)
            KClosure { params, captures, body } => {
                var s = scope.clone()
                for p in params.iter() {
                    let _ = s.insert(p.sym)
                }
                for c in captures.iter() {
                    if !scope.has(c.sym) {
                        this.report("capture `${c.name}` is not bound", e.span)
                    }
                }
                this.block(body, s, [], false)
            }
            KSelect { arms, else_expr } => {
                for a in arms.iter() {
                    this.expr(a.wait, scope, labels, in_loop)
                    var s = scope.clone()
                    this.binds(a.pattern, s)
                    this.expr(a.body, s, labels, in_loop)
                }
                if let Some(x) = else_expr {
                    this.expr(x.get(), scope, labels, in_loop)
                }
            }
        }
    }

    fun check_jump(&mut this, label: &string?, labels: &Vec[string?], in_loop: bool, span: Span) {
        if !in_loop {
            this.report("`break` / `continue` outside a loop", span)
        } else if let Some(l) = label {
            if !labels.contains(Some(l.clone())) {
                this.report("unknown label `${l}`", span)
            }
        }
    }
}
