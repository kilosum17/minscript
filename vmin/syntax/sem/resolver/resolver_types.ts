import type { AliasDecl, AstType, BindingDecl, FuncDecl, GenericsDecl, ImplDecl, InterDecl, StructDecl, UnionDecl } from "../../parser/ast_types"

const int_types = [
    'u8', 'u32', 'u64', 'int',
    'i8', 'i32', 'i64',
] as const
export const int_set = new Set<string>(int_types)

const float_types = ['f32', 'f64'] as const
export const float_set = new Set<string>(float_types)

const bool_types = ['true', 'false'] as const
export const bool_set = new Set<string>(bool_types)


// export type BasicTypeKind = 'str' | 'char' | 'byte' | 'bool'
//     | typeof int_types[number] | typeof float_types[number]

// export type BasicType = {
//     kind: 'BasicType'
//     type: BasicTypeKind,
//     val: string,
// }

// export type CustType = {
//     kind: 'CustType',
//     name: string,
//     generics?: GenericsDecl
// }

// export type FuncType = {
//     kind: 'FuncType',
//     args: AllType[],
//     return: AllType
// }

// export type StructType = {
//     kind: 'StructType',
//     members: ResolveType[],
// }


// export type SemTypeKind = (
//     | FuncDecl | UnionDecl | AliasDecl | BasicType
//     | StructDecl | InterDecl | AstType
// )

export type ResolveType = {
    var_name: string,
    is_pub?: boolean,
    is_param?: boolean,
    is_uniontag?: boolean,
    parent_union?: string,
} & SemType //, 'kind'>

export type SemType = AstType & {
    gens?: string[]
}

