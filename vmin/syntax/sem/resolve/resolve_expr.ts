import type { Expr } from "../../parser/ast_types"
import { printAstNode } from "../../parser/ast_utils"
import type { ScopeRet, SemType, ScopeType } from "../utils/scope_type"

export type ResolvedType = {
    type: Expr | null
}

export const resolveExprType = ({ scope, expr: e }: {
    scope: ScopeType, expr: Expr,
}): SemType | null => {
    switch (e.kind) {
        case "Literal": {
            if (e.mode === 'BYTE') return ({ kind: 'BasicType', type_name: 'byte', name: e.val })
            if (e.mode === 'CHAR') return ({ kind: 'BasicType', type_name: 'char', name: e.val })
            if (e.mode === 'NUM') {
                let type_name: 'int' | 'f64'
                if (e.val.includes('.')) type_name = 'f64'
                else type_name = 'int'
                return ({ kind: 'BasicType', type_name, name: e.val })
            }
            throw new Error(`Unkown literal kind ${printAstNode(e)}`)
        }
        case "Var": {
            return scope.get({ mode: 'var', name: e.name })
        }
        case "Unary": {

        }
        case "Binary": {

        }
        case "Cast": {

        }
        case "Member": {

        }
        case "Match": {

        }
        case "If": {

        }
        case "Call": {

        }
        case "String": {

        }
        case "Range": {

        }
        case "ErrorProp": {

        }
        case "StructInit": {

        }
        case "RecordInit": {

        }
        case "VecInit": {

        }
        case "Closure": {

        }
        case "MapInit": {

        }
        case "Index": {

        }
        case "SetInit": {

        }
        case "Recover": {

        }
        case "Bracket": {

        }
        case "GenericExpr": {

        }
        case "Await": {

        }
        case "Block": {

        }
        case "Lock": {

        }
        case "Select": {

        }
        case "TupleInit": {

        }
    }
    return null
}