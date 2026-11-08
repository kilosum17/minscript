// Type witnesses (spec §14.1), ported from minscript/src/witness.ts: which generic functions need a
// generic parameter at run time.
//
// A function needs the witness of its parameter `T` if its body (closures included)
// - calls a static of `T` (`T.default()`, a `wstatic` node),
// - passes `T` to a builtin that needs a type's shape (`json.from_value.[T]`, `call.shapes`), or
// - calls a function that needs a witness, passing a type that mentions `T` (`load.[Vec[T]]()`).
// The last rule makes it a fixpoint over the whole program. The back end passes each needed witness
// as a hidden argument, built from the call's `witness_args`.
package hir

/// A call to a function that may need witnesses: the callee, and its generics as instantiated.
type Edge = { callee: string, args: Vec[t(int, Shape?)] }

/// Sets `witnesses` on every function of the program that needs some.
pub fun compute_witnesses(program: &mut Program) {
    var by_name = m{} as Map[string, int]
    var i = 0
    for f in program.funs.iter() {
        by_name[f.name.clone()] = i
        i += 1
    }
    var needs = [] as Vec[Vec[int]]
    var edges = [] as Vec[Vec[Edge]]
    for f in program.funs.iter() {
        var own = [] as Vec[int]
        var out = [] as Vec[Edge]
        if !f.generics.is_empty() {
            if let Some(b) = &f.body {
                walk_block(b, own, out)
            }
        }
        needs.push(own)
        edges.push(out)
    }
    var changed = true
    for changed {
        changed = false
        var k = 0
        for k < program.funs.len() {
            for edge in edges[k].iter() {
                let Some(callee) = by_name.get(edge.callee) else { continue }
                for w in needs[callee].clone().iter() {
                    var given: Shape? = None
                    for a in edge.args.iter() {
                        let t(s, shape) = a
                        if s == w {
                            given = shape.clone()
                            break
                        }
                    }
                    var ps = [] as Vec[int]
                    shape_params(given, ps)
                    for p in ps.iter() {
                        if !needs[k].contains(p) {
                            needs[k].push(p)
                            changed = true
                        }
                    }
                }
            }
            k += 1
        }
    }
    var k = 0
    for k < program.funs.len() {
        let mine = needs[k].clone()
        program.funs[k].witnesses = program.funs[k].generics.filter(#{ g => mine.contains(g) })
        k += 1
    }
}

/// The generic parameters a shape mentions.
fun shape_params(s: &Shape?, out: &mut Vec[int]) {
    match s {
        Some(SParam(p)) => out.push(p)
        Some(SVec(x)) | Some(SOpt(x)) | Some(SMap(x)) => {
            if let Some(inner) = x {
                shape_params(Some(inner.get().clone()), out)
            }
        }
        _ => {}
    }
}

fun walk_block(b: &HBlock, own: &mut Vec[int], edges: &mut Vec[Edge]) {
    for s in b.stmts.iter() {
        match s {
            HLet { value, .. } => walk(value, own, edges)
            HDo(e) => walk(e, own, edges)
        }
    }
    if let Some(v) = &b.value {
        walk(v.get(), own, edges)
    }
}

fun walk_list(es: &Vec[HExpr], own: &mut Vec[int], edges: &mut Vec[Edge]) {
    for e in es.iter() {
        walk(e, own, edges)
    }
}

fun walk_opt(e: &Box[HExpr]?, own: &mut Vec[int], edges: &mut Vec[Edge]) {
    if let Some(x) = e {
        walk(x.get(), own, edges)
    }
}

fun add_params(s: &Shape?, own: &mut Vec[int]) {
    var ps = [] as Vec[int]
    shape_params(s, ps)
    for p in ps.iter() {
        if !own.contains(p) {
            own.push(p)
        }
    }
}

fun walk(e: &HExpr, own: &mut Vec[int], edges: &mut Vec[Edge]) {
    match &e.kind {
        KWstatic { witness, args, .. } => {
            add_params(witness, own)
            walk_list(args, own, edges)
        }
        KCall { callee, args, shapes, witness_args } => {
            for s in (shapes ?? []).iter() {
                add_params(s, own)
            }
            if !witness_args.is_empty() {
                edges.push(Edge { callee: callee.clone(), args: witness_args.clone() })
            }
            walk_list(args, own, edges)
        }
        KCopy(x) | KWiden(x) | KAwait(x) => walk(x.get(), own, edges)
        KDyncall { recv, args, .. } => {
            walk(recv.get(), own, edges)
            walk_list(args, own, edges)
        }
        KCallValue { callee, args } => {
            walk(callee.get(), own, edges)
            walk_list(args, own, edges)
        }
        KExtern { args, .. } => walk_list(args ?? [], own, edges)
        KStruct { fields, .. } | KRecord(fields) => {
            for f in fields.iter() {
                walk(f.value, own, edges)
            }
        }
        KVariant { fields, .. } => walk_list(fields, own, edges)
        KTuple(xs) | KConcat(xs) => walk_list(xs, own, edges)
        KVec(xs) | KArray(xs) | KSet(xs) => {
            for x in xs.iter() {
                match x {
                    HValue(v) | HSpread(v) => walk(v, own, edges)
                }
            }
        }
        KMap(entries) => {
            for en in entries.iter() {
                match en {
                    HPair { key, value } => {
                        walk(key, own, edges)
                        walk(value, own, edges)
                    }
                    HEntrySpread(x) => walk(x, own, edges)
                }
            }
        }
        KRange { start, end, .. } => {
            walk_opt(start, own, edges)
            walk_opt(end, own, edges)
        }
        KField { object, .. } => walk(object.get(), own, edges)
        KIndex { object, index, .. } => {
            walk(object.get(), own, edges)
            walk(index.get(), own, edges)
        }
        KUnary { expr, .. } | KTruthy { expr, .. } | KToStr { expr, .. } | KCast { expr, .. } => walk(expr.get(), own, edges)
        KBinary { left, right, .. } | KAnd { left, right } | KOr { left, right } => {
            walk(left.get(), own, edges)
            walk(right.get(), own, edges)
        }
        KAssign { target, value, .. } => {
            walk(target.get(), own, edges)
            walk(value.get(), own, edges)
        }
        KIf { cond, then, else_block } => {
            walk(cond.get(), own, edges)
            walk_block(then, own, edges)
            if let Some(b) = else_block {
                walk_block(b, own, edges)
            }
        }
        KMatch { subject, arms } => {
            walk(subject.get(), own, edges)
            for a in arms.iter() {
                if let Some(g) = &a.guard {
                    walk(g, own, edges)
                }
                walk(a.body, own, edges)
            }
        }
        KLoop { body, step, .. } => {
            walk_block(body, own, edges)
            if let Some(s) = step {
                walk_block(s, own, edges)
            }
        }
        KBreak { value, .. } => walk_opt(value, own, edges)
        KReturn(v) => walk_opt(v, own, edges)
        KBlock(b) | KRecover(b) => walk_block(b, own, edges)
        KClosure { body, .. } => walk_block(body, own, edges)
        KSelect { arms, else_expr } => {
            for a in arms.iter() {
                walk(a.wait, own, edges)
                walk(a.body, own, edges)
            }
            walk_opt(else_expr, own, edges)
        }
        _ => {}
    }
}
