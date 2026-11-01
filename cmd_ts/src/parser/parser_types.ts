
export type AstNodeKind = "PackageDecl" | "ImportDecl"

export type AstNode =
    | AstError
    | PackageDecl
    | ImportDecl
    | FuncDecl
    | FuncParamsList
    | FuncParam
    | BlockDecl

export type AstError = {
    kind: 'Error',
    recoverBefore?: string[]
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
    params: FuncParamsList | AstError
    return: FuncType | AstError,
    block: BlockDecl | AstError,
}

export type FuncParamsList = {
    kind: 'ParamsList'
    params: (FuncParam | AstError)[]
}

export type FuncParam = {
    kind: 'Param'
    type: FuncType | AstError,
}

export type FuncType = {
    kind: 'Type'
    name: string,
    generics: []
}

export type BlockDecl = {
    kind: 'BlockDecl',
    statements: StatDecl[]
}

export type StatDecl =
    | {
        stat_kind: 'binding',
        mutable: boolean,
        lhs: {
            name: string,
            type: FuncType,
        },
        rhs: StatDecl
    } | {
        stat_kind: 'call'
        path: string,
        args: StatArgsList | AstError,
    } | {
        stat_kind: 'expr'
    } | {
        stat_kind: 'assign',
        rhs: StatDecl,
    }

export type StatArgsList = {

}
