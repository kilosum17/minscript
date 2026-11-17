
export type AstSpan = {
    start: number,
    end: number
}

export type AstNode = (
    | PackageDecl
    | ImportDecl
    | StructDecl
    | AliasDecl
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
)

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

export type AliasDecl = {
    kind: 'AliasDecl',
    name: string,
    is_pub: boolean,
    type: AstType,
    generics?: GenericsDecl
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
    is_option: boolean,
    span: AstSpan,
} & (
        {
            mode: 'var',
            name: string,
            generics?: GenericsDecl,
        } | {
            mode: 'func',
            args: AstType[],
            ret: AstType,
        } | {
            mode: 'tuple',
            items: AstType[]
        } | {
            mode: 'record',
            fields: {
                key: string,
                type: AstType
            }[]
        }
    )

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
    is_async: boolean,
    generics?: GenericsDecl,
    params: FuncParam[]
    return?: AstType,
    block: BlockDecl,
    span: AstSpan,
}

export type FuncParam = {
    kind: 'FuncParam',
    name: string,
    is_mut: boolean,
    type?: AstType,
    span: AstSpan,
}

export type BlockDecl = {
    kind: 'BlockDecl',
    items: (StmtDecl | Expr)[],
    span: AstSpan,
}

export type StmtDecl = {
    kind: 'Return',
    expr?: Expr,
    span: AstSpan,
} | {
    kind: 'Binding',
    name?: string
    bind_expr?: Expr
    is_pub: boolean,
    is_short: boolean
    is_mut: boolean
    is_shared: boolean
    expr?: Expr
    type?: AstType,
    span: AstSpan,
} | {
    kind: 'ForLoop',
    block: BlockDecl,
    span: AstSpan,
} & (
        {
            mode: 'in',
            is_await: boolean,
            var_name: string,
            var_name2?: string,
            expr: Expr,
        } | {
            mode: 'infinite',
        }
    )
    | {
        kind: 'Label',
        name: string,
        span: AstSpan,
    } | {
        kind: 'SemiColon',
        span: AstSpan,
    } | {
        kind: 'Continue',
        label?: string
        span: AstSpan,
    } | {
        kind: 'Break',
        label?: string
        span: AstSpan,
    }

export type SelectArm = {
    var_name?: string,
    expr: Expr,
    block: BlockDecl
    span: AstSpan,
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
    kind: 'Cast',
    oper: string,
    lhs: Expr,
    type: AstType,
    span: AstSpan,
} | {
    kind: 'Member',
    is_optional: boolean,
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
    span: AstSpan,
} | {
    kind: 'If',
    is_let: boolean,
    cond: Expr,
    variant?: Expr,
    then: BlockDecl,
    else?: BlockDecl | Expr,
    span: AstSpan,
} | {
    kind: 'Call',
    lhs: Expr,
    args: Expr[]
    span: AstSpan,
} | {
    kind: 'String',
    parts: (string | Expr)[]
    span: AstSpan,
} | {
    kind: 'Range',
    oper: string,
    start: Expr,
    end: Expr,
    span: AstSpan,
} | {
    kind: 'ErrorProp',
    lhs: Expr,
    span: AstSpan,
} | {
    kind: 'StructInit',
    lhs: Expr,
    fields: StructInitField[],
    span: AstSpan,
} | {
    kind: 'RecordInit',
    fields: StructInitField[],
    span: AstSpan,
} | {
    kind: 'VecInit',
    items: Expr[]
    span: AstSpan,
} | {
    kind: 'Closure',
    args?: { name: string, type?: AstType }[]
    block: BlockDecl,
    span: AstSpan,
} | {
    kind: 'MapInit',
    fields: MapInitField[]
    span: AstSpan,
} | {
    kind: 'Index',
    lhs: Expr,
    key: Expr,
    span: AstSpan,
} | {
    kind: 'SetInit',
    items: Expr[],
    span: AstSpan,
} | {
    kind: 'Recover',
    block: BlockDecl,
    span: AstSpan,
} | {
    kind: 'Bracket',
    expr: Expr
    span: AstSpan,
} | {
    kind: 'GenericExpr',
    type: AstType,
    span: AstSpan,
} | {
    kind: 'Await',
    expr: Expr,
    span: AstSpan,
} | {
    kind: 'Block',
    block: BlockDecl,
    span: AstSpan,
} | {
    kind: 'Lock',
    vars: Expr[],
    block: BlockDecl,
    span: AstSpan,
} | {
    kind: 'Select',
    arms: SelectArm[]
    span: AstSpan,
} | {
    kind: 'TupleInit',
    items: Expr[],
    span: AstSpan,
}

export type StructInitField = {
    mode: 'field',
    name: string,
    // is_pub: boolean,
    expr: Expr,
} | {
    mode: 'spread',
    expr: Expr,
}
export type MapInitField = {
    mode: 'field',
    key: Expr,
    val: Expr,
} | {
    mode: 'spread',
    expr: Expr,
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
    range: Expr,
    block: BlockDecl,
} | {
    mode: 'IfCond',
    var_name: string,
    cond: Expr,
    block: BlockDecl,
}

