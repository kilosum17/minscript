import type { AstNode, BlockDecl, GenericItem } from "./parser_types";
import type { Capture, MatchArm } from "./pratt_parser";

const MAX_INLINE = 70

export function printNode2(node: AstNode): string {
    return `> ${pr(node, 0)}`
}

// ---------- helpers ----------

const ind = (d: number) => '    '.repeat(d)

/** `open a, b, c close`; falls back to one item per line when too long or multi-line. */
function bracket(open: string, items: string[], close: string, d: number, spaced = false): string {
    if (items.length === 0) return `${open}${close}`
    const inner = items.join(', ')
    const inline = spaced ? `${open} ${inner} ${close}` : `${open}${inner}${close}`
    if (inline.length <= MAX_INLINE && !inline.includes('\n')) return inline
    const pad = ind(d + 1)
    return `${open}\n${items.map(i => pad + i).join(',\n')},\n${ind(d)}${close}`
}

function printGenerics(generics: GenericItem[] | undefined): string {
    if (!generics || generics.length === 0) return ''
    return `[${generics.map(g => pr(g, 0)).join(', ')}]`
}

function block(b: BlockDecl, d: number): string {
    if (b.statements.length === 0) return '{}'
    const pad = ind(d + 1)
    return `{\n${b.statements.map(s => pad + pr(s, d + 1)).join('\n')}\n${ind(d)}}`
}

/** A block or an expression used as a branch/arm body. */
function body(n: AstNode, d: number): string {
    return pr(n, d)
}

function printCapture(c: Capture): string {
    return c.mode === 'mut' ? `&mut ${c.name}` : c.mode === 'ref' ? `&${c.name}` : c.name
}

// Operator precedence, mirrors get_infix_bp in the Pratt parser.
const PREC: Record<string, number> = {
    '||': 1, '&&': 2,
    '==': 3, '!=': 3,
    '>': 4, '<': 4, '>=': 4, '<=': 4,
    '+': 5, '-': 5,
    '*': 6, '/': 6, '%': 6,
    '.': 8,
}

function exprPrec(n: AstNode): number {
    if ('type' in n) {
        if (n.type === 'Binary') return PREC[n.op] ?? 0
        if (n.type === 'Range') return 0.5
    }
    return 100
}

/** Print an operand, adding parentheses if it binds looser than `min`. */
function operand(n: AstNode, min: number, d: number): string {
    const s = pr(n, d)
    return exprPrec(n) < min ? `(${s})` : s
}

function fieldList(f: { name: string, val: AstNode }[], spread: AstNode | undefined, d: number): string[] {
    const items = f.map(x => `${x.name}: ${pr(x.val, d + 1)}`)
    if (spread) items.unshift(`...${pr(spread, d + 1)}`)
    return items
}

// ---------- main printer ----------

function pr(node: AstNode, d: number): string {
    if (!node) return '<>'

    if ('type' in node) {
        switch (node.type) {
            case 'Literal':
                return node.value
            case 'Var':
                return node.name
            case 'Unary':
                return `${node.op}${operand(node.right, 7, d)}`
            case 'Binary': {
                const p = PREC[node.op] ?? 0
                if (node.op === '.') {
                    return `${operand(node.left, p, d)}.${operand(node.right, p + 1, d)}`
                }
                return `${operand(node.left, p, d)} ${node.op} ${operand(node.right, p + 1, d)}`
            }
            case 'Range': {
                const s = node.start ? operand(node.start, 1, d) : ''
                const e = node.end ? operand(node.end, 1, d) : ''
                return `${s}${node.inclusive ? '..=' : '..'}${e}`
            }
            case 'Call': {
                const gens = node.generics?.length
                    ? `[${node.generics.map(g => pr(g, d)).join(', ')}]` : ''
                const args = bracket('(', node.args.map(a => pr(a, d + 1)), ')', d)
                return `${operand(node.callee, 8, d)}${gens}${args}`
            }
            case 'Index':
                return `${operand(node.object, 8, d)}[${pr(node.index, d)}]`
            case 'StrExpr': {
                const text = node.parts
                    .map(p => typeof p === 'string' ? p : `\${${pr(p, d)}}`)
                    .join('')
                return `"${text}"`
            }
            case 'StructInit': {
                const items = fieldList(node.fields, node.spread, d)
                return `${node.name ?? '_'}${bracket('{', items, '}', d, true)}`
            }
            case 'Record': {
                const items = fieldList(node.fields, node.spread, d)
                return `r${bracket('{', items, '}', d, true)}`
            }
            case 'Vec':
                return `v${bracket('[', node.items.map(i => pr(i, d + 1)), ']', d)}`
            case 'Array':
                return `a${bracket('[', node.items.map(i => pr(i, d + 1)), ']', d)}`
            case 'Tuple':
                return `t${bracket('(', node.items.map(i => pr(i, d + 1)), ')', d)}`
            case 'Set':
                return `s${bracket('{', node.items.map(i => pr(i, d + 1)), '}', d, true)}`
            case 'Map': {
                const entries = node.entries.map(e => `${pr(e.key, d + 1)}: ${pr(e.value, d + 1)}`)
                return `m${bracket('{', entries, '}', d, true)}`
            }
            case 'Closure': {
                const caps = node.captures?.length
                    ? `#[${node.captures.map(printCapture).join(', ')}]`
                    : '#'
                // `implicit` is true when the closure has an explicit `params =>` header
                const params = node.implicit
                    ? node.params.map(p => p.type ? `${p.name}: ${pr(p.type, d)}` : p.name).join(', ') + ' =>'
                    : ''
                const st = node.body.statements
                if (st.length === 0) return `${caps}{ ${params} }`.replace(/  +/g, ' ')
                if (st.length === 1) {
                    const inner = pr(st[0], d)
                    if (!inner.includes('\n')) {
                        return `${caps}{ ${params ? params + ' ' : ''}${inner} }`
                    }
                }
                const pad = ind(d + 1)
                const head = params ? `${caps}{ ${params}` : `${caps}{`
                return `${head}\n${st.map(s => pad + pr(s, d + 1)).join('\n')}\n${ind(d)}}`
            }
            case 'If': {
                const els = node.elseBranch ? ` else ${body(node.elseBranch, d)}` : ''
                return `if ${pr(node.condition, d)} ${block(node.thenBranch, d)}${els}`
            }
            case 'Match': {
                if (node.arms.length === 0) return `match ${pr(node.scrutinee, d)} {}`
                const pad = ind(d + 1)
                const arms = node.arms.map((a: MatchArm) => {
                    const isBlock = 'kind' in a.body && a.body.kind === 'BlockDecl'
                    const b = isBlock ? block(a.body as BlockDecl, d + 1) : pr(a.body, d + 1)
                    return `${pad}${pr(a.pattern, d + 1)} => ${b}${isBlock ? '' : ','}`
                })
                return `match ${pr(node.scrutinee, d)} {\n${arms.join('\n')}\n${ind(d)}}`
            }
            case 'For': {
                const b = block(node.body, d)
                switch (node.kind) {
                    case 'loop': return `for ${b}`
                    case 'cond': return `for ${pr(node.cond, d)} ${b}`
                    case 'in': return `for ${node.vars.join(', ')} in ${pr(node.iter, d)} ${b}`
                }
                return `<for?>`
            }
            case 'Break':
                return node.value ? `break ${pr(node.value, d)}` : 'break'
            case 'Continue':
                return 'continue'
        }
    }

    switch (node.kind) {
        case 'AstSkip':
            return `/* skip: ${node.message} */`
        case 'PackageDecl':
            return `package ${node.name}`
        case 'ImportDecl':
            return `import "${node.path}"${node.rename ? ` as ${node.rename}` : ''}`
        case 'FuncDecl': {
            const pub = node.is_public ? 'pub ' : ''
            const asy = node.is_async ? 'async ' : ''
            const ret = node.return && node.return.name !== 'void' ? ` -> ${pr(node.return, d)}` : ''
            const blk = node.block ? ` ${block(node.block, d)}` : ''
            return `${pub}${asy}fun ${node.name}${printGenerics(node.generics)}${pr(node.params, d)}${ret}${blk}`
        }
        case 'GenericItem':
            return `${node.name}${printGenerics(node.generics)}`
        case 'ParamsList':
            return `(${node.params.map(p => pr(p, d)).join(', ')})`
        case 'Param': {
            if (node.is_receiver) {
                return `${node.is_borrow ? '&' : ''}${node.is_muttable ? 'mut ' : ''}this`
            }
            return `${node.name}${node.type ? `: ${pr(node.type, d)}` : ''}`
        }
        case 'Type':
            return `${node.name}${printGenerics(node.generics)}`
        case 'BlockDecl':
            return block(node, d)
        case 'binding': {
            if (node.is_short) {
                return `${node.lhs.name} ${node.is_muttable ? ':==' : ':='} ${pr(node.rhs, d)}`
            }
            const kw = node.is_muttable ? 'var' : 'let'
            const ty = node.lhs.type ? `: ${pr(node.lhs.type, d)}` : ''
            return `${kw} ${node.lhs.name}${ty} = ${pr(node.rhs, d)}`
        }
        case 'assign':
            return `${pr(node.lhs, d)} ${node.oper} ${pr(node.rhs, d)}`
        case 'return':
            return node.expr ? `return ${pr(node.expr, d)}` : 'return'
        case 'StructDecl': {
            const pub = node.is_public ? 'pub ' : ''
            return `${pub}type ${node.name}${printGenerics(node.generics)} = ${pr(node.fields, d)}`
        }
        case 'StructFieldList': {
            if (node.fields.length === 0) return '{}'
            const pad = ind(d + 1)
            return `{\n${node.fields.map(f => `${pad}${pr(f, d + 1)},`).join('\n')}\n${ind(d)}}`
        }
        case 'StructField':
            return `${node.is_public ? 'pub ' : ''}${node.name}: ${pr(node.type, d)}`
        case 'UnionDecl': {
            const pub = node.is_public ? 'pub ' : ''
            return `${pub}union ${node.name}${printGenerics(node.generics)} = ${pr(node.fields, d)}`
        }
        case 'UnionFieldList': {
            if (node.fields.length === 0) return '{}'
            const pad = ind(d + 1)
            return `{\n${node.fields.map(f => `${pad}${pr(f, d + 1)},`).join('\n')}\n${ind(d)}}`
        }
        case 'UnionField': {
            switch (node.data.type) {
                case 'plain':
                    return node.name
                case 'tuple':
                    return `${node.name}(${node.data.items.map(i => pr(i.type, d)).join(', ')})`
                case 'struct':
                    return `${node.name} ${bracket('{', node.data.fields.fields.map(f => pr(f, d)), '}', d, true)}`
            }
            return node.name
        }
        case 'ImplBlock': {
            const pad = ind(d + 1)
            const methods = node.methods.map(m => pad + pr(m, d + 1)).join('\n\n')
            return `impl ${node.name}${printGenerics(node.generics)} {\n${methods}\n${ind(d)}}`
        }
        case 'InterBlock': {
            const pad = ind(d + 1)
            const methods = node.methods.map(m => pad + pr(m, d + 1)).join('\n')
            return `inter ${node.name}${printGenerics(node.generics)} = {\n${methods}\n${ind(d)}}`
        }
        default:
            return `<unknown ${(node as any).kind ?? JSON.stringify(node)}>`
    }
}