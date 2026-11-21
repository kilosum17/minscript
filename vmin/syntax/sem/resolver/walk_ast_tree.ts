import type { AstNode, AstSpan, GenericsDecl, MatchArm } from "../../parser/ast_types";

type Child = AstNode | undefined

function contains(span: AstSpan, pos: number) {
    return span.start <= pos && pos <= span.end
}

function genericsItems(g: GenericsDecl): Child[] {
    const out: Child[] = []
    for (const item of g.items) {
        if (Array.isArray(item)) out.push(item[0], ...item[1])
        else out.push(item)
    }
    return out
}

function matchArmChildren(arm: MatchArm): Child[] {
    switch (arm.mode) {
        case 'Range': return [arm.range, arm.block]
        case 'IfCond': return [arm.cond, arm.block]
        default: return [arm.block]
    }
}

/** Direct children of a node, in source order. */
function childrenOf(n: AstNode): Child[] {
    switch (n.kind) {
        // ---- declarations ----
        case 'PackageDecl':
        case 'ImportDecl':
        case 'NameDecl':
            return []
        case 'StructDecl':
            return [n.generics, ...n.suppers, n.fields_list]
        case 'AliasDecl':
            return [n.generics, n.type]
        case 'GenericDecl':
            return genericsItems(n)
        case 'StructFieldsList':
            return n.fields
        case 'StructField':
            return [n.type, n.init]
        case 'UnionDecl':
            return [n.generics, ...n.vars, ...n.methods]
        case 'UnionStruct':
            return [n.fields_list]
        case 'UnionTuple':
            return n.items
        case 'UnionBare':
            return []
        case 'FuncDecl':
            return [n.generics, ...n.params, n.return, n.block]
        case 'FuncParam':
            return n.mode === 'receiver' ? [] : [n.type]
        case 'ImplDecl':
            return [n.generics, n.struct_generics, ...n.methods]
        case 'InterDecl':
            return [n.generics, ...n.suppers, ...n.methods]

        // ---- types (kind is optional on AstType) ----
        case undefined:
        case 'AstType':
            switch (n.mode) {
                case 'var': return [n.generics]
                case 'tuple': return n.items
                case 'record':
                case 'struct':
                case 'union': return n.fields.map(f => f.type)
                case 'func': return [...n.args, n.ret]
                case 'union_bare': return []
            }
            return []

        // ---- statements ----
        case 'BlockDecl':
            return n.items
        case 'Binding':
            return [n.name, n.bind_expr, n.type, n.expr]
        case 'Return':
            return [n.expr]
        case 'ForLoop':
            switch (n.mode) {
                case 'in': return [n.expr, n.block]
                case 'infinite': return [n.block]
                case 'Cond': return [n.cond, n.block]
                case 'Let': return [n.pattern, n.expr, n.block]
            }
            return []
        case 'Label':
        case 'SemiColon':
        case 'Continue':
        case 'Break':
            return []

        // ---- expressions ----
        case 'Var':
        case 'Literal':
            return []
        case 'Unary':
        case 'Await':
        case 'Bracket':
            return [n.expr]
        case 'Binary':
            return [n.lhs, n.rhs]
        case 'Cast':
            return [n.lhs, n.type]
        case 'Member':
            return [n.lhs, n.rhs]
        case 'Call':
            return [n.lhs, ...n.args]
        case 'Index':
            return [n.lhs, n.key]
        case 'ErrorProp':
            return [n.lhs]
        case 'Range':
            return [n.start, n.end]
        case 'String':
            return n.parts.filter((p): p is Exclude<typeof p, string> => typeof p !== 'string')
        case 'StructInit':
            return [n.lhs, ...n.fields.map(f => f.expr)]
        case 'RecordInit':
            return n.fields.map(f => f.expr)
        case 'MapInit':
            return n.fields.flatMap(f => f.mode === 'field' ? [f.key, f.val] : [f.expr])
        case 'VecInit':
        case 'SetInit':
        case 'TupleInit':
            return n.items
        case 'Closure':
            return [...(n.args ?? []).map(a => a.type), n.block]
        case 'Match':
            return [n.cond, ...n.arms.flatMap(matchArmChildren)]
        case 'If':
            return [n.cond, n.variant, n.then, n.else]
        case 'Block':
        case 'Recover':
            return [n.block]
        case 'Lock':
            return [...n.vars, n.block]
        case 'Select':
            return n.arms.flatMap(a => [a.expr, a.block])
        case 'GenericExpr':
            return [n.type]
    }
    const _exhaustive: never = n
    return []
}

/**
 * Path from the outermost node to the deepest node whose span contains `pos`.
 * Empty array if nothing matches.
 */
export function findNodePath(root: AstNode[] | AstNode | undefined, pos: number): AstNode[] {
    const path: AstNode[] = []

    const visit = (n: Child): boolean => {
        if (!n) return false
        // AstType's span is optional: descend without pruning when it's missing
        if (n.span && !contains(n.span, pos)) return false

        path.push(n)
        for (const child of childrenOf(n)) {
            if (visit(child)) return true
        }
        if (n.span) return true // no child matched, so this node is the deepest
        path.pop()
        return false
    }

    for (const n of Array.isArray(root) ? root : [root]) {
        if (visit(n)) break
    }
    return path
}

/** Deepest node whose span contains `pos`. */
export function walkAstTree(root: AstNode[] | AstNode | undefined, pos: number): AstNode | undefined {
    return findNodePath(root, pos).at(-1)
}