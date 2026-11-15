
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
    span: AstSpan,
}

export type StmtDecl = {
    kind: 'Return',
    expr?: Expr,
} | {
    kind: 'Binding',
    name: string
    is_short: boolean
    is_mut: boolean
    expr?: Expr
}

export type Expr = {
    kind: 'Var',
    name: string,
    span: AstSpan,
} | {
    kind: 'Unary',
    oper: string,
    expr: Expr,
    span: AstSpan,
} | {
    kind: 'Binary',
    oper: string,
    lhs: Expr,
    rhs: Expr,
    span: AstSpan,
} | {
    kind: 'Member',
    lhs: Expr,
    rhs: Expr,
    span: AstSpan,
} | {
    kind: 'Literal',
    val: string,
    span: AstSpan,
} | {
    kind: 'Match',
    cond?: Expr,
    arms: MatchArm[]
} | {
    kind: 'If',
    cond: Expr,
    then: BlockDecl,
    else?: BlockDecl | Expr,
} | {
    kind: 'Call',
    lhs: Expr,
    args: Expr[]
} | {
    kind: 'String',
    parts: (string | Expr)[]
}

export type MatchArm = {
    mode: 'Struct',
    name: string,
    fields?: string[],
    block: BlockDecl,
} | {
    mode: 'Tuple',
    name: string,
    fields?: string[],
    block: BlockDecl,
} | {
    mode: 'Bare',
    name: string,
    block: BlockDecl,
} | {
    mode: 'Literal'
    val: String,
    block: BlockDecl,
} | {
    mode: 'Range'
    oper: string,
    start: Expr,
    end: Expr,
    block: BlockDecl,
} | {
    mode: 'IfCond',
    var_name: string,
    cond: Expr,
    block: BlockDecl,
}

