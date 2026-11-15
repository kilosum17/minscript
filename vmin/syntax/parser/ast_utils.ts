import type { AstNode } from "./ast_types"

export function print(n?: AstNode, d?: number): string {
    d ??= 0

    const inner = () => {
        if (!n) return ''
        switch (n.kind) {
            case "PackageDecl": {
                return `> package ${n.name}`
            }
            case "ImportDecl": {
                return `> import${n.is_pub ? ' pub' : ''} ${n.path}${n.alias ? ` as ${n.alias} ` : ''}`
            }
            case "StructDecl": {
                return `${n.is_pub ? 'pub ' : ''}type ${n.name}${print(n.generics, d + 1)}\n${print(n.fields_list, d + 1)}`
            }
            case "StructFieldsList": {
                return n.fields.map(f => print(f, d + 1)).join('\n')
            }
            case "StructField": {
                return `${n.is_pub ? 'pub ' : ''}${n.name}: ${print(n.type, 0)}`
            }
            case "GenericDecl": {
                return '[' + n.items.map(t => print(t, 0)).join(',') + ']'
            }
            case "AstType": {
                return `${n.name}${print(n.generics, 0)}${n.is_option ? '?' : ''}`
            }
            case "UnionDecl": {
                const parts = n.vars.map(v => print(v, d + 1)).join('\n')
                const methods = n.methods.map(v => print(v, d + 1)).join('\n')
                return `${n.is_pub ? 'pub ' : ''}union ${n.name}${print(n.generics, d + 1)}\n${parts}\n${methods}`
            }
            case "UnionBare": {
                return `${n.name}`
            }
            case "UnionStruct": {
                return `${n.name}\n${print(n.fields_list)}`
            }
            case "UnionTuple": {
                return `${n.name}(${n.items.map(v => print(v, 0)).join(',')})`
            }
            case "FuncDecl": {
                const params = n.params.map(p => print(p, 0)).join(',')
                const ret = n.return ? ` -> ${print(n.return)}` : ''
                const block = print(n.block, d + 1)
                return `${n.is_pub ? 'pub ' : ''}fn ${n.name}${print(n.generics, 0)}(${params})${ret}\n${block}`
            }
            case "FuncParam": {
                if (n.name == 'this') return n.is_mut ? '*this' : 'this'
                return `${n.name}:${n.is_mut ? '*' : ''}${print(n.type)}`
            }
            case "BlockDecl": {
                const body = n.items.map(t => print(t, d + 1)).join('\n')
                return body
            }
            case "Var": {
                return `Var(${n.name})`
            }
            case "Unary": {
                return `${n.oper}${print(n.expr)}`
            }
            case "Binary": {
                return `${n.oper}(${print(n.lhs)},${print(n.rhs)})`
            }
            case "Member": {
                return `${print(n.lhs)}.${print(n.lhs)}`
            }
            case "Literal": {
                return `Lit(${n.val})`
            }
            case "Match": {
                const arms = n.arms.map(m => {
                    if (m.mode == 'Struct') {
                        return `${m.name}{${m.fields?.join(',') || ''}}=>${print(m.block)}`
                    } else if (m.mode == 'Tuple') {
                        return `${m.name}(${m.fields?.join(',') || ''})=>${print(m.block)}`
                    } else if (m.mode == 'Bare') {
                        return `${m.name}=>${print(m.block)}`
                    } else if (m.mode == 'Literal') {
                        return `${m.val}=>${print(m.block)}`
                    } else if (m.mode == 'IfCond') {
                        return `${m.var_name} if ${print(m.cond)}=>${print(m.block)}`
                    } else if (m.mode == 'Range') {
                        return `${print(m.start)}${m.oper}${print(m.end)} =>${print(m.block)}`
                    } else {
                        return `TODO`
                    }
                }).join('\n')
                return `match ${print(n.cond)}\n${arms}`
            }
            case "If": {
                const else_ = n.else ? `\nelse ${print(n.else, d + 1)}` : ''
                return `if ${print(n.cond)}:\n${print(n.then, d + 1)}${else_}`
            }
            case "Call": {
                const args = n.args.map(n => print(n)).join(',')
                return `${print(n.lhs)}(${args})`
            }
            case "Return": {
                return `return ${print(n.exp)}`
            }
            case "String": {
                const parts = n.parts.map(p => {
                    if (typeof p === 'string') return p
                    return print(p, 0)
                }).join(' | ')
                return `str(${parts})`
            }
        }

        // return `> TODO [${n.kind}]`
    }
    let prefix = ' '.repeat(d)
    return inner().split('\n').map(n => prefix + n).join('\n')
}

export function printAstNode(n: AstNode): string {
    return print(n, 0)
}
