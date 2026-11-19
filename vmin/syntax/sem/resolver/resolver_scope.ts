import type { Expr } from "../../parser/ast_types";
import { printAstNode } from "../../parser/ast_utils";
import { checkOpers } from "./oper_utils";
import { toBasicType, type ResolveType, type ResolvedTypeKind } from "./resolver_types";
import { isBasicType, printSaveTypeKind } from "./resolver_utils";

export class ResScope {
    saved: ResolveType[] = []

    constructor(
        public parent?: ResScope,
        types?: ResolveType[],
    ) {
        if (types) this.saved.push(...types)
    }

    add(...types: ResolveType[]) {
        types = types.map(t => {
            const b = toBasicType(t.mode)
            if (b) {
                return { ...t, mode: b }
            }
            return t
        })
        this.saved.push(...types)
    }
    clear() {
        this.saved = []
    }
    get(args: { name: string }) {
        const { name } = args
        const exp = this.saved.find(f => f.name == name)
        if (exp) {
            return exp
        }
    }


    resExpr(e: Expr): ResolvedTypeKind | undefined {
        switch (e.kind) {
            case "Literal": {
                if (e.mode === 'BYTE') return ({ kind: 'Basic', decl: { kind: 'BasicType', type: 'byte', val: e.val } })
                if (e.mode === 'CHAR') return ({ kind: 'Basic', decl: { kind: 'BasicType', type: 'char', val: e.val } })
                if (e.mode === 'NUM') {
                    let type_name: 'int' | 'f64'
                    if (e.val.includes('.')) type_name = 'f64'
                    else type_name = 'int'
                    return ({ kind: 'Basic', decl: { kind: "BasicType", type: type_name, val: e.val } })
                }
                if (e.mode === 'BOOL') {
                    return ({ kind: 'Basic', decl: { kind: "BasicType", type: 'bool', val: e.val } })
                }
                throw new Error(`Unkown literal kind ${printAstNode(e)}`)
            }
            case "Var": {
                const t = this.get({ name: e.name })
                console.log(`Get var ${e.name}=${t}`, this.saved.map(d => d.name))
                return t?.mode
            }
            case "Unary": {
                return undefined
            }
            case "Binary": {
                const lhs = this.resExpr(e.lhs)
                const rhs = this.resExpr(e.rhs)
                const math_oper = ['+', '-', '/', '*']
                console.log('got ', printSaveTypeKind(lhs), printSaveTypeKind(rhs))
                const numLhs = isBasicType(lhs)
                const numRhs = isBasicType(rhs)

                if (numLhs && numRhs) {
                    const oper = checkOpers(e.oper, numLhs.type, numRhs.type)
                    return ({
                        kind: 'Basic',
                        decl: { kind: "BasicType", type: oper as any, val: '' }
                    })
                }
            }
            case "String": {
                return ({
                    kind: 'Basic',
                    decl: { kind: "BasicType", type: 'str', val: '' }
                })
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
        return undefined
    }

}
