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
        return { ast_type: funcToType(node), type_id: node.type_id }
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
            type_id: node.type_id,
            ast_type,
        }
    }
    return undefined
}

export function getTypeOf(scope: SemScope, name: string) {

    const run = (scope: SemScope, name: string) => {

        const type_decl = scope.type_decls.find(f => f.name == name)
        if (type_decl) {
            const bindType = declToBindingType(type_decl)
            if (bindType) return bindType
        }
        const bind = scope.bindings.find(b => b.var_name == name)
        if (bind) return bind
        if (scope.parent) {
            return run(scope.parent, name)
        }
        return undefined

    }

    return run(scope, name)
}

export type GetTypeOf = ReturnType<typeof getTypeOf>

