import type { AstNode, AstType, FuncDecl } from "../../parser/ast_types";
import { printAstType } from "../../parser/ast_utils";
import type { ScopeType } from "../utils/scope_type";
import { Resolver2 } from "./resolver_2";
import { ResScope } from "./resolver_scope";
import { type ResolveType, type SemType } from "./resolver_types";
import { printSaveTypeKind, resTypeName } from "./resolver_utils";

export class Resolver {
    astNodes: AstNode[] = []
    parentScope: ScopeType | null = null
    f_scope = new ResScope()
    r2: Resolver2

    constructor(
        public name: string
    ) {
        this.r2 = new Resolver2(this)

    }

    resolve(
        astNodes: AstNode[],
        parentScope: ScopeType | null,
    ) {
        this.astNodes = astNodes
        this.parentScope = parentScope
        this.f_scope.clear()

        this.resolveRoot()
    }

    resolveRoot() {
        const funcDeclToType = (func: FuncDecl): SemType => {
            const args: SemType[] = func.params.map(p => {
                if (p.mode == 'receiver') {
                    return {
                        kind: 'AstType', mode: 'var', is_mut: p.is_mut,
                        is_option: false, name: 'this',
                    } satisfies SemType
                } else {
                    return p.type
                }
            })
            return {
                kind: 'AstType', mode: 'func',
                args, is_mut: false, is_option: false, ret: func.return
            }
        }
        this.astNodes.forEach(n => {
            if (n.kind == 'StructDecl') {
                const fields = n.fields_list.fields.map(f => {
                    let type: AstType
                    if (f.kind === 'FuncDecl') type = funcDeclToType(f)
                    else type = f.type
                    return { key: f.name, type, is_pub: f.is_pub }
                })

                const type = {
                    mode: 'struct', var_name: n.name, fields,
                    is_mut: false, is_option: false,
                } satisfies ResolveType

                this.f_scope.add(type)
            }
            if (n.kind == 'FuncDecl') {
                const type = funcDeclToType(n)
                const resolve = {
                    ...type, kind: 'AstType', var_name: n.name,
                    // generics: n.generics,
                } satisfies ResolveType
                this.f_scope.add(resolve)
                this.resolveFunc(n,)
            }

        })
    }

    resolveFunc(func: FuncDecl) {
        let scope = new ResScope(this.f_scope)
        func.params.forEach(p => {
            if (p.mode == 'var') {
                scope.add({
                    ...p.type,
                    var_name: p.name, is_param: true,
                })
            }
        })
        for (const s of func.block.items) {
            if (s.kind == 'Binding') {
                console.log('Binding ', s.name)
                let inferedType = undefined as undefined | SemType
                if (s.expr) {
                    inferedType = scope.resExpr(s.expr)
                }

                if (s.type) {
                    if (inferedType && !this.r2.isSame(inferedType, s.type)) {
                        // error
                    }
                    scope.add({
                        ...s.type,
                        var_name: s.name || '',
                    } satisfies ResolveType)
                } else {
                    if (inferedType) {
                        scope.add({
                            ...inferedType,
                            var_name: s.name || '',
                        } satisfies ResolveType)

                    }
                }
                console.log(`${s.name}:${printAstType(s.type!)} Infered: ${resTypeName(inferedType!)}`)
            }
        }
    }

}