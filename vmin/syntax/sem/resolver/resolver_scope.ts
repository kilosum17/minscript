import type { Expr } from "../../parser/ast_types";
import { printAstNode, printAstType } from "../../parser/ast_utils";
import { checkOpers } from "./oper_utils";
import { type ResolveType, type SemType } from "./resolver_types";
import { printSaveTypeKind, resTypeName } from "./resolver_utils";

export class ResScope {
    saved: ResolveType[] = []

    constructor(
        public parent?: ResScope,
        types?: ResolveType[],
    ) {
        if (types) this.saved.push(...types)
    }

    add(...types: ResolveType[]) {
        this.saved.push(...types)
    }
    clear() {
        this.saved = []
    }
    get(args: { name: string, path?: string }): ResolveType | undefined {
        const { name, path } = args
        let exp = this.saved.find(f => f.var_name == name)
        if (!exp) {
            exp = this.parent?.get(args)
        }
        if (!exp) {
            console.log('VArs', this.parent?.saved.map(s => s.var_name))
        }
        if (exp && path != undefined) {
            if (exp.mode == 'var') {
                return this.path(exp.name, path)
            }
        }
        return exp
    }

    path(name: string, path: string): ResolveType | undefined {
        const exp = this.get({ name })
        if (exp?.mode == 'struct') {
            const field = exp.fields.find(f => f.key == path)
            if (field) {
                return { ...field.type, var_name: '', } satisfies ResolveType
            } else {
                console.log('Stt', exp.var_name, exp.fields.map(f => f.key))
            }
        } else {
            console.log('Dss', exp?.mode, exp)
        }
        return undefined
    }

    resExpr(e: Expr): SemType | undefined {
        switch (e.kind) {
            case "Literal": {
                if (e.mode === 'BYTE') return { mode: 'var', name: 'byte' } satisfies SemType
                if (e.mode === 'CHAR') return { mode: 'var', name: 'char' } satisfies SemType
                if (e.mode === 'NUM') {
                    let name: 'int' | 'f64'
                    if (e.val.includes('.')) name = 'f64'
                    else name = 'int'
                    return { mode: 'var', name } satisfies SemType
                }
                if (e.mode === 'BOOL') {
                    return { mode: 'var', name: 'bool' } satisfies SemType
                }
                throw new Error(`Unkown literal kind ${printAstNode(e)}`)
            }
            case "Var": {
                const t = this.get({ name: e.name })
                console.log(`Get var ${e.name}=${t}`, this.saved.map(d => d.var_name))
                return t
            }
            case "Unary": {
                return undefined
            }
            case "Binary": {
                const lhs = this.resExpr(e.lhs)
                const rhs = this.resExpr(e.rhs)
                console.log('got ', printAstType(lhs!), printAstType(rhs!))
                const nlhs = resTypeName(lhs)
                const nrhs = resTypeName(rhs)
                const type = checkOpers(e.oper, nlhs, nrhs)
                if (type) {
                    return {
                        mode: 'var', name: type,
                    } satisfies SemType
                }
            }
            case "String": {
                return { mode: 'var', name: 'str', } satisfies SemType
            }
            case "StructInit": {
                // console.log(`>> `, printAstType(e.lhs), '{}')
                if (e.lhs.kind == 'Var') {
                    const t = this.get({ name: e.lhs.name })
                    if (t?.mode != 'struct') {
                        throw new Error('StructInit on invalid type:' + t + " " + e.lhs.name)
                    }
                    return { mode: 'var', name: t.var_name } satisfies SemType
                } else {
                    throw new Error('Unexpected struct path: ' + printAstNode(e.lhs))
                }
            }
            case "Member": {
                if (e.lhs.kind === 'Var' && e.rhs.kind === 'Var') {
                    const t = this.get({
                        name: e.lhs.name,
                        path: e.rhs.name,
                    })
                    if (t?.mode == 'var') {
                        return t
                    } else {
                        throw new Error('Unexpected memebr kind: ' + printAstNode(e.lhs))
                    }
                } else {
                    throw new Error('Unexpected memebr path: ' + printAstNode(e.lhs))
                }
            }
            case "MapInit": {
                const f0 = e.fields[0]
                if (f0 != undefined) {
                    let ktype = ''
                    let vtype = ''
                    if (f0.mode == 'spread') {

                    } else if (f0.mode == 'field') {
                        ktype = resTypeName(this.resExpr(f0.key))
                        vtype = resTypeName(this.resExpr(f0.val))
                    } else {
                        throw new Error('Unkown map field mode')
                    }
                    return { mode: 'var', name: 'Map', gens: [ktype, vtype] } as SemType
                }
                return undefined
            }
            case "VecInit": {
                const f0 = e.items[0]
                if (f0 != undefined) {
                    const type = resTypeName(this.resExpr(f0))
                    return { mode: 'var', name: 'Vec', gens: [type] }
                }
                return undefined
            }
            case "SetInit": {
                const f0 = e.items[0]
                if (f0 != undefined) {
                    const type = resTypeName(this.resExpr(f0))
                    return { mode: 'var', name: 'Set', gens: [type] }
                }
                return undefined
            }
            case "Cast": {

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
            case "RecordInit": {

            }
            case "Closure": {

            }

            case "Index": {

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
