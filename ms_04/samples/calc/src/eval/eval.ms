package eval

import "app.syntax.*"

/// Argument values of one call, keyed by the parameter's Ident node (identity hashing).
type Frame {
    locals: Map[Ident, f64] = m{}
}

type Interp {
    globals: Map[LetDecl, f64] = m{}
    out: Vec[str] = []
    depth: int = 0

    fn eval(*this, e: Expr, frame: Frame) -> Result[f64, str] {
        match e {
            Num(n) => Ok(n.value)
            Var(id) => match id.decl {                   // a once field reads as `Decl?`
                Some(Global(d)) => Ok(this.globals[d])
                Some(Param(p)) => Ok(frame.locals[p])
                Some(Func(_)) => Err("`${id.name.text()}` is a function; call it")
                None => Err("`${id.name.text()}` was never resolved")
            }
            Neg(u) => Ok(-this.eval(u.operand, frame)?)
            Bin(b) => {
                l := this.eval(b.left, frame)?
                r := this.eval(b.right, frame)?
                match b.op {
                    "+" => Ok(l + r)
                    "-" => Ok(l - r)
                    "*" => Ok(l * r)
                    "/" => if r == 0.0 { Err("division by zero") } else { Ok(l / r) }
                    _ => Err("`${b.op}` is not an operator")
                }
            }
            Call(c) => {
                let Some(Func(f)) = c.callee.decl else {
                    return Err("`${c.callee.name.text()}` is not a function")
                }
                if f.params.len() != c.args.len() {
                    return Err("`${f.name.name.text()}` takes ${f.params.len()} arguments, got ${c.args.len()}")
                }
                if this.depth >= 100 { return Err("calls nested too deeply") }
                var callee = Frame {}
                for p, i in f.params {
                    callee.locals[p] = this.eval(c.args[i], frame)?
                }
                this.depth += 1
                r := this.eval(f.body, callee)           // `callee`'s last use: it moves in
                this.depth -= 1
                r
            }
        }
    }
}

/// Runs a resolved program and returns what it printed.
pub fn run(stmts: Vec[Stmt]) -> Result[Vec[str], str] {
    var vm = Interp {}
    for s in stmts {
        match s {
            LetStmt(d) => {
                v := vm.eval(d.value, Frame {})?
                vm.globals[d] = v
            }
            FnStmt(_) => {}
            PrintStmt(e) => {
                v := vm.eval(e, Frame {})?
                vm.out.push("${v}")
            }
        }
    }
    Ok(vm.out)
}
