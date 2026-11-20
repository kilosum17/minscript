import type { AstNode, AstType, FuncDecl, StructDecl } from "../../parser/ast_types";
import type { Resolver } from "./resolver";
import type { ResolveType, SemType } from "./resolver_types";

export class ResolveAdder {

    constructor(
        public r: Resolver
    ) { }

    addAll(nodes: AstNode[]) {
        const funcDeclToType = (func: FuncDecl): SemType => {
            const args: SemType[] = func.params.map(p => {
                if (p.mode == 'receiver') {
                    return {
                        kind: 'AstType', mode: 'var', is_mut: p.is_mut,
                        is_option: false, type_name: 'this',
                    } satisfies SemType
                } else {
                    return p.type
                }
            })
            return {
                kind: 'AstType', mode: 'func',
                args, ret: func.return
            }
        }

        const structDeclToType = (struct: Pick<StructDecl, 'name' | 'fields_list'>): ResolveType => {
            const fields = struct.fields_list.fields.map(f => {
                let type: AstType
                if (f.kind === 'FuncDecl') type = funcDeclToType(f)
                else type = f.type
                return { key: f.name, type, is_pub: f.is_pub }
            })

            const type = {
                mode: 'struct', var_name: struct.name, fields,
                is_mut: false, is_option: false,
            } satisfies ResolveType
            return type
        }

        nodes.forEach(n => {
            if (n.kind == 'StructDecl') {
                const type = structDeclToType(n)
                this.r.f_scope.add(type)
                this.r.addSymbol(n, type)
            }
            if (n.kind == 'FuncDecl') {
                const type = funcDeclToType(n)
                const resolve = {
                    ...type, kind: 'AstType', var_name: n.name,
                    // generics: n.generics,
                } satisfies ResolveType
                this.r.f_scope.add(resolve)
                this.r.resolveFunc(n)
                this.r.addSymbol(n, resolve)
            }
            if (n.kind == 'UnionDecl') {
                const vars = n.vars.map(f => {
                    let type: ResolveType
                    if (f.kind === 'UnionStruct') {
                        type = {
                            ...structDeclToType({
                                fields_list: f.fields_list,
                                name: f.name,
                            }),
                            is_uniontag: true, parent_union: n.name
                        }
                    } else if (f.kind == 'UnionBare') {
                        type = {
                            mode: 'union_bare', is_uniontag: true, parent_union: n.name,
                            type_name: f.name, var_name: n.name,
                        }
                    } else if (f.kind == 'UnionTuple') {
                        type = {
                            mode: 'tuple', is_uniontag: true, parent_union: n.name,
                            items: f.items, var_name: f.name,
                        }
                    } else {
                        throw new Error('Unkown union variant')
                    }

                    return [{ key: f.name, is_pub: true, type }, type, f] as const
                })
                const methods = n.methods.map(m => {
                    const type = funcDeclToType(m)
                    return { key: m.name, type, is_pub: m.is_pub }
                })
                const fields = [...vars.map(v => v[0]), ...methods]
                const type = {
                    mode: 'union', var_name: n.name, fields,
                    is_mut: false, is_option: false,
                } satisfies ResolveType

                this.r.f_scope.add(type)
                this.r.addSymbol(n, type)

                vars.forEach(v => {
                    this.r.f_scope.add(v[1])
                    this.r.addSymbol(v[2], v[1])
                })

            }
        })
    }
}