import type { TExpr } from "./pratt_parser"

export type AstNodeKind = "PackageDecl" | "ImportDecl"

export type AstNode =
    | AstSkip
    | PackageDecl
    | ImportDecl
    | FuncDecl
    | FuncParamsList
    | FuncParam
    | FuncType
    | BlockDecl
    | StructDecl
    | StructFieldList
    | StructField
    | UnionDecl
    | UnionFieldList
    | UnionField
    | StatDecl
    | TExpr
    | ImplBlock
    | InterBlock
    | GenericItem

export type AstSkip = {
    kind: 'AstSkip'
    message: string
}

export type PackageDecl = {
    kind: "PackageDecl",
    name: string,
}

export type ImportDecl = {
    kind: 'ImportDecl',
    path: string,
    rename: string,
}

export type FuncDecl = {
    kind: 'FuncDecl',
    is_public: boolean,
    is_async: boolean,
    name: string,
    params: FuncParamsList
    return: FuncType,
    generics: GenericItem[]
    block?: BlockDecl,
}

export type FuncParamsList = {
    kind: 'ParamsList'
    params: (FuncParam)[]
}

export type FuncParam = {
    kind: 'Param'
    name: string,
    type?: FuncType,
    is_borrow: boolean,
    is_muttable: boolean,
    is_receiver: boolean,
}

export type FuncType = {
    kind: 'Type'
    name: string,
    generics: GenericItem[]
}

export type BlockDecl = {
    kind: 'BlockDecl',
    statements: (StatDecl | TExpr)[]
}

export type StatDecl =
    | {
        kind: 'binding',
        is_muttable: boolean,
        is_short: boolean,
        lhs: {
            name: string,
            type?: FuncType,
        },
        rhs: TExpr
    } | {
        kind: 'assign',
        oper: string
        lhs: TExpr,
        rhs: TExpr,
    } | {
        kind: 'return',
        expr: TExpr | null,
    }

export type StructDecl = {
    kind: 'StructDecl',
    name: string,
    is_public: boolean,
    generics: GenericItem[],
    fields: StructFieldList
}

export type StructFieldList = {
    kind: "StructFieldList"
    fields: (StructField)[]
}

export type StructField = {
    kind: "StructField"
    name: string,
    is_public: boolean
    type: FuncType,
}

export type UnionDecl = {
    kind: "UnionDecl"
    name: string,
    is_public: boolean,
    generics: GenericItem[],
    fields: UnionFieldList
}

export type UnionFieldList = {
    kind: "UnionFieldList"
    fields: (UnionField)[]
}

export type UnionField = {
    kind: "UnionField"
    name: string,
    data: {
        type: 'plain',
    } | {
        type: 'tuple',
        items: { type: FuncType }[]
    } | {
        type: 'struct',
        fields: StructFieldList,
    },
}

export type GenericItem = {
    kind: 'GenericItem'
    name: string,
    generics?: GenericItem[],
}

export type ImplBlock = {
    kind: 'ImplBlock'
    name: string
    interfaces: [],
    generics: GenericItem[]
    methods: (FuncDecl)[]

}


export type InterBlock = {
    kind: 'InterBlock'
    name: string
    generics: GenericItem[],
    methods: (FuncDecl)[]

}
