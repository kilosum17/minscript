import type { AstNode, AstType, FuncDecl } from "../../parser/ast_types";
import type { SemScope } from "./SemScope";
import type { BindingType, TypeDecl } from "./symbol";

function declToBindingType(node: TypeDecl): BindingType | undefined {

    const funcToType = (func: FuncDecl) => {
        const args = func.params
            .filter(p => p.mode === 'var')
            .map(p => {
                // if (p.mode == 'var') {
                return { ...p.type }
                // }
            })
        const ast_type: AstType = {
            mode: 'func',
            args,
            ret: func.return,
        }
        return ast_type
    }

    if (node.kind === 'FuncDecl') {
        return {
            ast_type: funcToType(node), decl_hint: node.name,
            type_id: node.type_id,
        }
    }
    if (node.kind === 'StructDecl') {
        const fields = node.fields_list.fields.map(f => {
            let type: AstType
            if (f.kind === 'FuncDecl') {
                type = funcToType(f)
            } else {
                type = { ...f.type } satisfies AstType
            }
            return { key: f.name, is_pub: f.is_pub, type }
        })
        const ast_type: AstType = {
            mode: 'struct',
            fields,
        }
        return {
            type_id: node.type_id, decl_hint: node.name,
            ast_type,
        }
    }
    return undefined
}

const run = (scope: SemScope, arg: { name?: string, id?: number }) => {
    const { name, id } = arg
    if (!name && (id == undefined || id === null)) throw new Error('Scope Resolution expects name|id')

    const type_decl = scope.type_decls.find(f => {
        if (name) return f.name === name
        if (Number.isSafeInteger(id)) return f.type_id == id
        return false
    })
    if (type_decl) {
        const bindType = declToBindingType(type_decl)
        if (bindType) return bindType
    }

    const bind = scope.bindings.find(f => {
        if (name) return f.var_name === name
        // if (Number.isSafeInteger(id)) return f.type_id == id
        return false
    })
    if (bind) return bind
    if (scope.parent) {
        return run(scope.parent, arg)
    }

    return undefined
}

export function getScopeName(scope: SemScope, name: string) {
    return run(scope, { name })
}

export function getScopeTypeDecl(scope: SemScope, id: number) {
    return run(scope, { id })
}

