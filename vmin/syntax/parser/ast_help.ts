import type { AstNode, Expr } from "./ast_types"

const exprKinds = [
    'Var',
    'Unary',
    'Binary',
    'Cast',
    'Member',
    'Literal',
    'Match',
    'If',
    'Call',
    'String',
    'Range',
    'ErrorProp',
    'StructInit',
    'RecordInit',
    'VecInit',
    'Closure',
    'MapInit',
    'Index',
    'SetInit',
    'Recover',
    'Bracket',
    'GenericExpr',
    'Await',
    'Block',
    'Lock',
    'Select',
    'TupleInit',
] as const
const expSet = new Set(exprKinds)

export function isExpr(n: AstNode): Expr | undefined {
    const kind = (n?.kind || '')
    if (expSet.has(kind as any)) return n as Expr
    return undefined
}


