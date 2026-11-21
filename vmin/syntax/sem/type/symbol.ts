import type { AliasDecl, AstType, Expr, FuncDecl, StructDecl, UnionDecl } from "../../parser/ast_types"

export type TypeDeclItem = | FuncDecl | StructDecl
    | UnionDecl | AliasDecl

export type TypeDecl = TypeDeclItem & {
    type_id: number
}

export type Binding = {
    var_name: string,
    is_shared?: boolean,
    init_expr?: Expr,
    tuple_pos?: number,
    struct_key?: string,
} & BindingType

export type BindingType = {
    type_id?: number,
    ast_type: AstType,
}
