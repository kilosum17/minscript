package sema

import "app.syntax.*"

pub type Diag {
    pub msg: str
    pub span: Span
    pub warning: bool = false
}

/// Results that stay beside the tree: a side table keyed by node identity (§11.1).
pub type Resolved {
    pub uses: Map[Decl, int] = m{}
    pub diags: Vec[Diag] = []
}

/// A scope is a persistent map (§11.5): `with` returns a new version in O(log n) and older
/// versions stay valid, so a function body can extend the globals without copying them.
type Scope = PMap[Symbol, Decl]

/// Binds every name in `stmts`. Each `Ident.decl` is a once field: running this twice over the
/// same tree panics with PanicKind.AlreadySet (§12.3), which is what a pass ordering bug should do.
pub fn resolve(stmts: Vec[Stmt]) -> Resolved {
    var out = Resolved {}
    var globals = PMap.new.[Symbol, Decl]() as Scope
    for s in stmts {
        match s {
            LetStmt(d) => {
                expr(d.value, globals, out)             // `out` is passed as *Resolved: unmarked
                globals = globals.with(d.name.name, Global(d))
                d.name.decl = Global(d)                  // a once write, through a read-only view
            }
            FnStmt(f) => {
                globals = globals.with(f.name.name, Func(f))   // before the body: allows recursion
                f.name.decl = Func(f)
                var scope = globals                      // shares `globals`; `with` never copies it
                for p in f.params {
                    scope = scope.with(p.name, Param(p))
                    p.decl = Param(p)
                }
                expr(f.body, scope, out)
            }
            PrintStmt(e) => expr(e, globals, out)
        }
    }
    for s in stmts {
        if let LetStmt(d) = s {
            if (out.uses.get(Global(d)) ?? 0) == 0 {
                out.diags.push(Diag { msg: "`${d.name.name.text()}` is never used", span: d.name.span, warning: true })
            }
        }
    }
    out
}

/// Summary: reads [e, scope] writes [out.uses, out.diags]. Recursive, so pass 6 iterates this SCC;
/// it converges on the first extra round because the paths never grow.
fn expr(e: Expr, scope: Scope, out: *Resolved) {
    match e {
        Num(_) => {}
        Var(id) => bind(id, scope, out)
        Neg(u) => expr(u.operand, scope, out)
        Bin(b) => {
            expr(b.left, scope, out)
            expr(b.right, scope, out)
        }
        Call(c) => {
            bind(c.callee, scope, out)
            for a in c.args { expr(a, scope, out) }
        }
    }
}

fn bind(id: Ident, scope: Scope, out: *Resolved) {
    let Some(d) = scope.get(id.name) else {
        out.diags.push(Diag { msg: "unknown name `${id.name.text()}`", span: id.span })
        return
    }
    id.decl = d
    out.uses[d] = (out.uses.get(d) ?? 0) + 1
}
