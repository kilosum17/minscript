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
    | StatDecl
    | TExpr
    | ImplBlock

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
}

export type FuncDecl = {
    kind: 'FuncDecl',
    is_public: boolean,
    is_async: boolean,
    name: string,
    params: FuncParamsList
    return: FuncType,
    block: BlockDecl,
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
    generics: []
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
        lhs: TExpr,
        rhs: TExpr,
    }

export type StructDecl = {
    kind: 'StructDecl',
    name: string,
    is_public: boolean,
    generics: [],
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

export type ImplBlock = {
    kind: 'ImplBlock'
    name: string
    interfaces: [],
    methods: (FuncDecl)[]

}
