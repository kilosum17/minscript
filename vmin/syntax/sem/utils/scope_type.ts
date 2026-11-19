import path_ from 'node:path'
import type { AliasDecl, AstNode, AstType, BindingDecl, FuncDecl, ImplDecl, InterDecl, StructDecl, UnionDecl } from '../../parser/ast_types'


export type ScopeRet = SemType

const int_types = [
    'u8', 'u32', 'u64', 'int',
    'i8', 'i32', 'i64',
] as const
const float_types = ['f32', 'f64'] as const
type PrimType = 'str' | 'char' | 'byte' | typeof int_types[number] | typeof float_types[number]

export type BasicType = {
    kind: 'BasicType'
    name: string,
    type_name: PrimType,
}

export type VarType = {
    kind: 'VarType',
    name: string,
    type: SemType
}

export type SemType = (
    | FuncDecl | UnionDecl | AliasDecl | VarType | BasicType
    | StructDecl | BindingDecl | InterDecl | ImplDecl
)

export class ScopeType {
    name: string = ''
    types = [] as SemType[]

    constructor(
        public path: string,
        public parent?: ScopeType,
    ) {
        this.name = path_.basename(path)
    }

    addAll(nodes: AstNode[]) {
        nodes.forEach(n => this.addNode(n))
    }

    addNode(node: AstNode) {
        if (node.kind == 'FuncDecl' || node.kind == 'UnionDecl' ||
            node.kind == 'AliasDecl' || node.kind === 'StructDecl' ||
            node.kind == 'Binding' || node.kind == 'InterDecl' || node.kind === 'ImplDecl'
        ) {
            this.types.push({ ...node })
        }
    }

    addType(t: SemType) {
        this.types.push(t)
    }

    get(args: {
        mode: 'var',
        name: string,
    }): ScopeRet | null {
        const { mode, name } = args

        const run = (): ScopeRet | null => {
            if (mode == 'var') {
                for (const t of this.types) {
                    if (t.kind === 'VarType') {
                        if (t.name === name) {
                            return t
                        }
                    }
                }
            }
            return null
        }

        let res = run()
        if (res == null && this.parent) {
            res = this.parent?.get(args)
        }
        return res
    }

}
