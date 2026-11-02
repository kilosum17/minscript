import type { AstError, AstNode, FuncType, StatDecl, ImplBlock } from "./parser_types";

function printError(node: AstError) {
    return `Error('${node.message}')`
}

function printType(typeNode: FuncType | AstError): string {
    if (typeNode.kind === 'Error') return printError(typeNode)
    return typeNode.name
}

function printStat(stat: StatDecl | AstError): string {
    if (stat.kind === 'Error') return printError(stat)
    switch (stat.kind) {
        case 'binding': {
            const mut = stat.mutable ? 'mut ' : ''
            const typeStr = stat.lhs.type ? `: ${printType(stat.lhs.type)}` : ''
            return `let ${mut}${stat.lhs.name}${typeStr} = ${printStat(stat.rhs)}`
        }
        case 'call': {
            const argsStr = stat.args.kind === 'Error' 
                ? printError(stat.args) 
                : stat.args.args.map(printStat).join(', ')
            return `${stat.path}(${argsStr})`
        }
        case 'expr':
        case 'str_expr':
            return stat.parts.map(p => typeof p === 'string' ? p : printStat(p)).join('')
        case 'assign':
            return `= ${printStat(stat.rhs)}`
    }
}

export function strNode(node: AstNode | FuncType | ImplBlock): string {
    if(!node)return `> null`
    if (node.kind === 'Error') return printError(node)
    if (node.kind === 'Type') return printType(node)
    if (node.kind === 'ImplBlock') {
        const methods = node.methods.map(m => m.kind === 'Error' ? printError(m) : strNode(m)).join('\n    ')
        return `impl ${node.name} {\n    ${methods}\n}`
    }

    switch (node.kind) {
        case "PackageDecl": 
            return `> package ${node.name}`
        case "ImportDecl": 
            return `> import "${node.path}"`
        case "FuncDecl": {
            const header = (node.is_public ? 'pub ' : '') +
                (node.is_async ? 'async ' : '') + `fun ${node.name}(`
            const params = node.params.kind === 'Error' ? printError(node.params) : strNode(node.params)
            const ret = node.return.kind === 'Error' ? printError(node.return) : ` -> ${printType(node.return)}`
            const block = node.block.kind === 'Error' ? printError(node.block) : strNode(node.block)
            return `> ${header}${params})${ret} ${block}`
        }
        case "ParamsList":
            return node.params.map(p => p.kind === 'Error' ? printError(p) : strNode(p)).join(', ')
        case "Param": {
            const borrow = node.is_borrow ? '&' : ''
            const mut = node.is_muttable ? 'mut ' : ''
            const typeStr = node.type ? `: ${printType(node.type)}` : ''
            return `${borrow}${mut}${node.name}${typeStr}`
        }
        case "BlockDecl": {
            const stmts = node.statements.map(s => s.kind === 'Error' ? printError(s) : printStat(s)).join('\n    ')
            return `{\n    ${stmts}\n}`
        }
        case "StructDecl": {
            const pub = node.is_public ? 'pub ' : ''
            const fields = node.fields.kind === 'Error' ? printError(node.fields) : strNode(node.fields)
            return `${pub}struct ${node.name} ${fields}`
        }
        case "StructFieldList":
            return `{\n    ` + node.fields.map(f => f.kind === 'Error' ? printError(f) : strNode(f)).join(',\n    ') + `\n}`
        case "StructField": {
            const pub = node.is_public ? 'pub ' : ''
            const typeStr = node.type.kind === 'Error' ? printError(node.type) : printType(node.type)
            return `${pub}${node.name}: ${typeStr}`
        }
        case "ArgsList":
            return node.args.map(a => a.kind === 'Error' ? printError(a) : printStat(a)).join(', ')
        case "binding":
        case "call":
        case "expr":
        case "assign":
        case "str_expr":
            return printStat(node)
    }
}