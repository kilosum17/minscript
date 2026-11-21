import { getLogger } from "../utils/log"
import type { AstNode } from "./ast_types"

export const ParseLog = getLogger('parser')

export class AstPrint {
    constructor(
        private no_body = false
    ) {

    }
    print(n?: AstNode, d?: number): string {
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
                    return `\n${n.is_pub ? 'pub ' : ''}type ${n.name}${this.print(n.generics, d + 1)}\n${this.print(n.fields_list, d + 1)}`
                }
                case "StructFieldsList": {
                    return n.fields.map(f => this.print(f, d + 1)).join('\n')
                }
                case "StructField": {
                    return `${n.is_pub ? 'pub ' : ''}${n.name}: ${this.print(n.type, 0)}${n.init ? '=' + this.print(n.init) : ''}`
                }
                case "GenericDecl": {
                    const items = n.items.map(t => {
                        if (Array.isArray(t)) {
                            const inner = t[1].length > 0 ? ':' + t[1].map(c => this.print(c)).join(',') : ''
                            return `${this.print(t[0])}${inner}`
                        }
                        return this.print(t, 0)
                    }).join(',')
                    return `[${items}]`
                }

                case undefined:
                case "AstType": {
                    if (n.mode == 'func') {
                        const args = n.args.map(n => this.print(n)).join(',')
                        return `${n.is_option ? '?' : ''}(${args})->${this.print(n.ret)}`
                    }
                    if (n.mode == 'tuple') {
                        const items = n.items.map(n => this.print(n)).join(',')
                        return `t(${items})`
                    }
                    if (n.mode == 'record') {
                        const items = n.fields.map(n => {
                            return `${n.key}:${this.print(n.type)}`
                        }).join(',\n')
                        return `r{${items}}`
                    }
                    if (n.mode == 'struct') {
                        return `struct{...}`
                    }
                    if (n.mode == 'union') {
                        return `union{...}`
                    }
                    if (n.mode == 'union_bare') {
                        return `bare(${n.type_name})`
                    }
                    return `${n.is_mut ? '*' : ''}${n.type_name}${this.print(n.generics, 0)}${n.is_option ? '?' : ''}`
                }
                case "UnionDecl": {
                    const parts = n.vars.map(v => this.print(v, d + 1)).join('\n')
                    const methods = n.methods.map(v => this.print(v, d + 1)).join('\n')
                    return `${n.is_pub ? 'pub ' : ''}union ${n.name}${this.print(n.generics, d + 1)}\n${parts}\n${methods}`
                }
                case "UnionBare": {
                    return `${n.name}`
                }
                case "UnionStruct": {
                    return `${n.name}\n${this.print(n.fields_list)}`
                }
                case "UnionTuple": {
                    return `${n.name}(${n.items.map(v => this.print(v, 0)).join(',')})`
                }
                case "FuncDecl": {
                    const params = n.params.map(p => this.print(p, 0)).join(',')
                    const ret = n.return ? ` -> ${this.print(n.return)}` : ''
                    const block = this.print(n.block, d + 1)
                    return `\n${n.is_pub ? 'pub ' : ''}${n.is_async ? 'async ' : ''}fn ${n.name}${this.print(n.generics, 0)}(${params})${ret}\n${block}`
                }
                case "FuncParam": {
                    if (n.mode == 'var') {
                        return `${n.name}:${this.print(n.type)}`
                    } else if (n.mode == 'receiver') {
                        return n.is_mut ? '*this' : 'this'
                    } else if (n.mode == 'variadic') {
                        return `...${n.name}:${this.print(n.type)}`
                    }
                    return `TODO`
                }
                case "BlockDecl": {
                    if (this.no_body) return ``
                    const body = n.items.map(t => this.print(t, d + 1)).join('\n')
                    return body
                }
                case "Var": {
                    return `${n.name}`
                }
                case "Unary": {
                    return `${n.oper}${this.print(n.expr)}`
                }
                case "Binary": {
                    return `${n.oper}(${this.print(n.lhs)},${this.print(n.rhs)})`
                }
                case "Member": {
                    return `${this.print(n.lhs)}.${this.print(n.rhs)}`
                }
                case "Literal": {
                    return `Lit(${n.val})`
                }
                case "Match": {
                    const arms = n.arms.map(m => {
                        if (m.mode == 'Struct') {
                            return `${m.name}{${m.fields?.join(',') || ''}}=>${this.print(m.block)}`
                        } else if (m.mode == 'Tuple') {
                            return `${m.name}(${m.fields?.join(',') || ''})=>${this.print(m.block)}`
                        } else if (m.mode == 'Bare') {
                            return `${m.name}=>${this.print(m.block)}`
                        } else if (m.mode == 'Literal') {
                            return `${m.val}=>${this.print(m.block)}`
                        } else if (m.mode == 'IfCond') {
                            return `${m.var_name} if ${this.print(m.cond)}=>${this.print(m.block)}`
                        } else if (m.mode == 'Range') {
                            return `${this.print(m.range)} =>${this.print(m.block)}`
                        } else {
                            return `TODO`
                        }
                    }).join('\n')
                    return `match ${this.print(n.cond)}\n${arms}`
                }
                case "If": {
                    const else_ = n.else ? `\nelse ${this.print(n.else, d + 1)}` : ''
                    return `if ${n.is_let ? 'let' : ''} ${this.print(n.cond)}${n.variant ? '=' + this.print(n.variant) : ''}:\n${this.print(n.then, d + 1)}${else_}`
                }
                case "Call": {
                    const args = n.args.map(n => this.print(n)).join(',')
                    return `${this.print(n.lhs)}(${args})`
                }
                case "Return": {
                    return `return ${this.print(n.expr)}`
                }
                case "String": {
                    const parts = n.parts.map(p => {
                        if (typeof p === 'string') return `"${p}"`
                        return this.print(p, 0)
                    }).join(' | ')
                    return `str(${parts})`
                }
                case "Binding": {
                    const symb = n.is_short ? (n.is_mut ? ':==' : ':=') : (n.is_mut ? 'var' : 'let')
                    const type = !n.is_short && n.type ? ':' + this.print(n.type) : ''
                    const shared = n.is_shared ? 'shared ' : ''
                    const name = n.name ? n.name : this.print(n.bind_expr)
                    return `${shared}${n.is_short ? '' : symb} ${name}${type}${n.is_short ? symb : '='} ${this.print(n.expr)}`
                }
                case "Range": {
                    return `${this.print(n.start)}${n.oper}${this.print(n.end)}`
                }
                case "ForLoop": {
                    if (n.mode == 'in') {
                        return `for ${n.is_await ? 'await ' : ''}${n.var_name} in ${this.print(n.expr)}\n${this.print(n.block, d + 1)}`
                    } else if (n.mode == 'infinite') {
                        return `for \n${this.print(n.block, d + 1)}`
                    } else if (n.mode == 'Cond') {
                        return `for ${this.print(n.cond)}\n${this.print(n.block)}`
                    } else if (n.mode == 'Let') {
                        return `for let ${this.print(n.pattern)}=${this.print(n.expr)}\n${this.print(n.block)}`
                    }
                    return `> for TODO`
                }
                case "ErrorProp": {
                    return `${this.print(n.lhs, d + 1)}?`
                }
                case "StructInit": {
                    const fields = n.fields.map(f => {
                        if (f.mode == 'field') {
                            return `${f.name}: ${this.print(f.expr, d + 1)}`
                        } else if (f.mode == 'spread') {
                            return `...${this.print(f.expr, d + 1)}`
                        } else {
                            return `TODO`
                        }
                    }).join('\n')
                    return `${this.print(n.lhs)}{${fields}}`
                }
                case "VecInit": {
                    const items = n.items.map(t => this.print(t, 0)).join(',\n')
                    return `vec[${items}]`
                }
                case "Closure": {
                    const args = n.args ? `${n.args.join(',')}=>` : ''
                    return `#{${args}\n${this.print(n.block, d + 1)}`
                }
                case "Label": {
                    return `Label(${n.name})`
                }
                case "MapInit": {
                    const fields = n.fields.map(f => {
                        if (f.mode == 'field') {
                            return `${this.print(f.key)}: ${this.print(f.val, d + 1)}`
                        } else if (f.mode == 'spread') {
                            return `...${this.print(f.expr, d + 1)}`
                        } else {
                            return `TODO`
                        }
                    }).join('\n')
                    return `m{\n${fields}`
                }
                case "Index": {
                    return `${this.print(n.lhs)}[${this.print(n.key)}]`
                }
                case "SetInit": {
                    const items = n.items.map(t => this.print(t)).join(',')
                    return `s{${items}`
                }
                case "Recover": {
                    return `recover ${this.print(n.block)}`
                }
                case "Bracket": {
                    return `(${this.print(n.expr)})`
                }
                case "Cast": {
                    return `(${this.print(n.lhs)} ${n.oper} ${this.print(n.type)})`
                }
                case "GenericExpr": {
                    return `.[${this.print(n.type)}]`
                }
                case "RecordInit": {
                    const fields = n.fields.map(f => {
                        if (f.mode == 'field') {
                            return `${f.name}: ${this.print(f.expr, d + 1)}`
                        } else if (f.mode == 'spread') {
                            return `...${this.print(f.expr, d + 1)}`
                        } else {
                            return `TODO`
                        }
                    }).join('\n')
                    return `r{\n${fields}`
                }
                case "Select": {
                    const arms = n.arms.map(m => {
                        return `${m.var_name ? `${m.var_name}: ` : ''}${this.print(m.expr)}=>${this.print(m.block)}`
                    }).join('\n')
                    return `select \n${arms}`
                }
                case "Await": {
                    return `(await ${this.print(n.expr)})`
                }
                case "SemiColon": {
                    return `;`
                }
                case "Block": {
                    return `block: ${this.print(n.block, d + 1)}`
                }
                case "Lock": {
                    const vars = n.vars.map(v => this.print(v)).join(',')
                    return `lock ${vars}: \n${this.print(n.block, d + 1)}`
                }
                case "TupleInit": {
                    const items = n.items.map(n => this.print(n)).join(',')
                    return `t(${items})`
                }
                case "Continue": {
                    return `continue ${n.label || ''}`
                }
                case "Break": {
                    return `break ${n.label || ''}`
                }
                case "AliasDecl": {
                    return `${n.is_pub ? 'pub ' : ''}type ${n.name}${this.print(n.generics)}=${this.print(n.type)}`
                }
                case "ImplDecl": {
                    const methods = n.methods.map(m => this.print(m)).join('\n')
                    return `imp ${this.print(n.generics)} ${n.struct}${this.print(n.struct_generics)}\n${methods}`
                }
                case "InterDecl": {
                    const methods = n.methods.map(m => this.print(m)).join('\n')
                    return `${n.is_pub ? 'pub ' : ''}inter ${n.name}${this.print(n.generics)} \n${methods}`
                }
                case "NameDecl": {
                    return `${n.text}`
                }
            }
            // return `> TODO [${n.kind}]`
        }
        let prefix = ' '.repeat(d)
        return inner().split('\n').map(n => prefix + n).join('\n')
    }

}

const nodePrinter = new AstPrint(false)
const typePrinter = new AstPrint(true)

export function printAstNode(n: AstNode | undefined): string {
    return nodePrinter.print(n, 0)
}

export function printAstType(n: AstNode | undefined): string {
    return typePrinter.print(n, 0)
}
