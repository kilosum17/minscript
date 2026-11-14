
export type AstSpan = {
    start: number,
    end: number
}

export type AstNode =
    | PackageDecl
    | ImportDecl
    | StructDecl
    | StructFieldsList
    | StructField
    | GenericsDecl
    | AstType
    | UnionDecl
    | UnionItem
    | FuncDecl
    | FuncParam
    | BlockDecl
    | Expr
    | StmtDecl

export type PackageDecl = {
    kind: 'PackageDecl',
    name: string,
    span: AstSpan,
}

export type ImportDecl = {
    kind: 'ImportDecl',
    path: string,
    is_pub: boolean,
    alias?: string,
    span: AstSpan,
}

export type StructDecl = {
    kind: 'StructDecl',
    name: string,
    is_pub: boolean,
    generics?: GenericsDecl,
    fields_list: StructFieldsList,
    span: AstSpan,
}


export type GenericsDecl = {
    kind: 'GenericDecl',
    items: AstType[]
    span: AstSpan,
}

export type StructFieldsList = {
    kind: 'StructFieldsList',
    fields: (StructField | FuncDecl)[],
    span: AstSpan,
}

export type StructField = {
    kind: 'StructField',
    name: string,
    type: AstType,
    is_pub: boolean,
    init?: Expr
    span: AstSpan,
}

export type AstType = {
    kind: "AstType",
    name: string,
    is_option: boolean,
    generics?: GenericsDecl,
    span: AstSpan,
}

export type UnionDecl = {
    kind: 'UnionDecl',
    name: string,
    is_pub: boolean,
    vars: UnionItem[],
    generics?: GenericsDecl,
    span: AstSpan,
    methods: FuncDecl[]
}

export type UnionItem = {
    name: string,
    span: AstSpan,
} & (
        {
            kind: 'UnionStruct',
            fields_list: StructFieldsList
        } | {
            kind: 'UnionTuple',
            items: AstType[],
        } | {
            kind: 'UnionBare',
        }
    )

export type FuncDecl = {
    kind: 'FuncDecl',
    name: string,
    is_pub: boolean,
    generics?: GenericsDecl,
    params: FuncParam[]
    return?: AstType,
    block: BlockDecl,
}

export type FuncParam = {
    kind: 'FuncParam',
    name: string,
    is_mut: boolean,
    type?: AstType,
}

export type BlockDecl = {
    kind: 'BlockDecl',
    items: (StmtDecl | Expr)[],
}

export type StmtDecl = {
    kind: 'StmtDecl',
}

export type Expr = {
    kind: 'Var',
    name: string,
    span: AstSpan,
} | {
    kind: 'Unary',
    expr: Expr,
    span: AstSpan,
} | {
    kind: 'Binary',
    oper: string,
    lhs: Expr,
    rhs: Expr,
} | {
    kind: 'Member',
    lhs: Expr,
    rhs: Expr,
}

