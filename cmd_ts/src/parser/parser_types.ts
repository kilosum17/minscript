
export type AstNodeKind = "PackageDecl" | "ImportDecl"

export type AstNode =
    | AstError
    | PackageDecl
    | ImportDecl
    | FuncDecl
    | FuncParamsList
    | FuncParam
    | BlockDecl
    | StructDecl
    | StructFieldList
    | StructField
    | ArgsList
    | StatDecl

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
    name: string,
    type?: FuncType | AstError,
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
    statements: (StatDecl | AstError)[]
}

export type StatDecl =
    | {
        kind: 'binding',
        mutable: boolean,
        lhs: {
            name: string,
            type: FuncType,
        },
        rhs: StatDecl
    } | {
        kind: 'call'
        path: string,
        args: ArgsList | AstError,
    } | {
        kind: 'expr'
    } | {
        kind: 'assign',
        rhs: StatDecl,
    }


export type StructDecl = {
    kind: 'StructDecl',
    name: string,
    is_public: boolean,
    generics: [],
    fields: StructFieldList | AstError
}

export type StructFieldList = {
    kind: "StructFieldList"
    fields: (StructField | AstError)[]
}

export type StructField = {
    kind: "StructField"
    name: string,
    is_public: boolean
    type: FuncType | AstError,
}

export type ImplBlock = {
    kind: 'ImplBlock'
    name: string
    interfaces: [],
    methods: (FuncDecl | AstError)[]

}

export type ArgsList = {
    kind: 'ArgsList',
    args: (StatDecl | AstError)[],
}
