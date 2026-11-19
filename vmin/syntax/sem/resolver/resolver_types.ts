import type { AliasDecl, AstType, BindingDecl, FuncDecl, ImplDecl, InterDecl, StructDecl, UnionDecl } from "../../parser/ast_types"

const int_types = [
    'u8', 'u32', 'u64', 'int',
    'i8', 'i32', 'i64',
] as const
export const int_set = new Set(int_types)

const float_types = ['f32', 'f64'] as const
export const float_set = new Set(float_types)

export type BasicTypeKind = 'str' | 'char' | 'byte' | 'bool'
    | typeof int_types[number] | typeof float_types[number]

export type BasicType = {
    kind: 'BasicType'
    type: BasicTypeKind,
    val: string,
}

// export type SemTypeKind = (
//     | FuncDecl | UnionDecl | AliasDecl | BasicType
//     | StructDecl | InterDecl | AstType
// )

export type ResolveType = {
    name: string,
    is_pub?: boolean,
    is_param?: boolean,
    mode: ResolvedTypeKind,
}

export type ResolvedTypeKind =
    {
        kind: 'Func',
        decl: FuncDecl,
    } | {
        kind: 'Union',
        decl: UnionDecl,
    } | {
        kind: 'Alias',
        decl: AliasDecl,
    } | {
        kind: 'Struct',
        decl: StructDecl,
    } | {
        kind: 'Basic',
        decl: BasicType,
    } | {
        kind: 'Inter',
        decl: InterDecl,
    } | {
        kind: 'Var',
        type: AstType,
    } | {
        kind: 'ScopeRef',
        ref: ResolveType,
    }

export function toBasicType(t: ResolvedTypeKind): { kind: 'Basic', decl: BasicType } | null {
    if (t.kind === 'Var') {
        if (t.type.mode == 'var') {
            const name = t.type.name
            let type: BasicTypeKind | null = null
            if (int_set.has(name as 'int')) {
                type = name as 'int'
            }
            if (float_set.has(name as 'f32')) {
                type = name as 'f32'
            }
            if (name == 'bool') {
                type = 'bool'
            }
            if (type) {
                return { kind: 'Basic', decl: { kind: 'BasicType', type, val: '' } }
            }
        }
    }
    return null
}