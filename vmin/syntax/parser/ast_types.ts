
export type AstSpan = {
    start: number,
    end: number
}

export type AstNode =
    (
        | PackageDecl
        | ImportDecl
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


