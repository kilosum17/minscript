import type { AstType } from "../../parser/ast_types";
import { printAstNode } from "../../parser/ast_utils";
import { getScopeTypeDecl, getScopeName } from "./scope_get_type_of";
import type { SemScope } from "./SemScope";
import type { Binding, BindingType } from "./symbol";

export function getReturnType(type: BindingType | undefined): BindingType | undefined {
    if (type?.ast_type?.mode === 'func') {
        const ret: AstType = type.ast_type.ret || { mode: 'var', type_name: 'void' }
        return { ast_type: ret }
    }
    return undefined
}


export function getMemberType(type: BindingType | undefined, key: string): BindingType | undefined {
    if (type?.ast_type?.mode === 'struct') {
        const ret = type.ast_type.fields.find(f => f.key === key)
        if (ret) return { ast_type: ret.type }
    }
    return undefined
}

export function printBindingType(scope: SemScope, type: BindingType | undefined) {
    if (!type) return `UNK`
    const ast = type.ast_type
    if (type.type_id && !type.ast_type) {
        const decl = getScopeTypeDecl(scope, type.type_id)
        // console.log('Get', decl)
        if (decl) return printBindingType(scope, decl)
    }
    // console.log('Print', type)
    if (ast?.mode == 'var') {
        const gens = ast.generics ? printAstNode(ast.generics) : ''
        const hintsJ = type.type_hints?.join(',') || ''
        const hints = hintsJ ? `[[${hintsJ}]]` : ''
        return `${ast.type_name}${gens}${hints}`
    }
    if (ast?.mode == 'struct') {
        return `${type.decl_hint}<${type.type_id}>`
    }
}

export function printBinding(scope: SemScope, bind: Binding | undefined) {
    if (!bind) return 'UNKN'
    return `${bind.var_name}: ${printBindingType(scope, bind)}`
}
