import type { AstNode } from "./parser_types";

export function printNode2(node: AstNode): string {
    return `> ${printNode(node)}`
}

function printNode(node: AstNode): string {
    if (!node) return "";

    if ('type' in node) {
        switch (node.type) {
            case 'Literal':
                return node.value;
            case 'Var':
                return node.name;
            case 'Unary':
                return `${node.op}${printNode(node.right)}`;
            case 'Binary':
                return `${printNode(node.left)} ${node.op} ${printNode(node.right)}`;
            case 'Call':
                return `${printNode(node.callee)}(${node.args.map(printNode).join(', ')})`;
            case 'StrExpr':
                return `"${node.parts.map(p => (typeof p === 'string' ? p : printNode(p))).join('')}"`;
            case 'StructInit': {
                const fields = node.fields.map(f => `${f.name} : ${printNode(f.val)}`)
                return `{\n${fields}\n}`
            }
            case 'Vec': {
                return `v[${node.items.map(v => printNode(v)).join(', ')}]`
            }
            case "Closure": {
                const params = node.params.map(s => `${s.name}${s.type ? ':' + printNode(s.type) : ''}`).join(', ')
                return `#{ ${params} => ${printNode(node.body)}`
            }
            case 'If': {
                return `if ${printNode(node.condition)} ${printNode(node.thenBranch)} ${node.elseBranch ? ' else ' + printNode(node.elseBranch) : ''} `
            }
        }
    }

    switch (node.kind) {
        case 'AstSkip':
            return `/* skip: ${node.message} */`;
        case 'PackageDecl':
            return `package ${node.name}`;
        case 'ImportDecl':
            return `import "${node.path}"`;
        case 'FuncDecl': {
            const pub = node.is_public ? 'pub ' : '';
            const asyncStr = node.is_async ? 'async ' : '';
            const params = printNode(node.params);
            const ret = node.return?.name ? ` -> ${printNode(node.return)}` : '';
            const block = printNode(node.block);
            return `${pub}${asyncStr}fn ${node.name}${params}${ret} ${block}`;
        }
        case 'ParamsList':
            return `(${node.params.map(printNode).join(', ')})`;
        case 'Param': {
            const mut = node.is_muttable ? 'mut ' : '';
            const borrow = node.is_borrow ? '&' : '';
            const typeStr = node.type ? `: ${printNode(node.type)}` : '';
            return `${borrow}${mut}${node.name}${typeStr}`;
        }
        case 'Type':
            return node.name;
        case 'BlockDecl':
            return `{\n${node.statements.map(s => `    ${printNode(s)}`).join('\n')}\n}`;
        case 'binding': {
            const mut = node.is_muttable ? 'var ' : 'let';
            const typeStr = node.lhs.type ? `: ${printNode(node.lhs.type)}` : '';
            if (node.is_short) {
                const oper = node.is_muttable ? ':==' : ':='
                return `${node.lhs.name} ${oper} ${printNode(node.rhs)}`;
            }
            return `${mut}${node.lhs.name}${typeStr} = ${printNode(node.rhs)}`;
        }
        case 'assign':
            return `${printNode(node.lhs)} = ${printNode(node.rhs)}`;
        case 'StructDecl': {
            const pub = node.is_public ? 'pub ' : '';
            const fields = printNode(node.fields);
            return `${pub}struct ${node.name} ${fields}`;
        }
        case 'StructFieldList':
            return `{\n${node.fields.map(f => `${printNode(f)}`).join(',\n')}\n}`;
        case 'StructField': {
            const pub = node.is_public ? 'pub ' : '';
            return `${pub}${node.name}: ${printNode(node.type)}`;
        }
        case 'ImplBlock': {
            const methods = node.methods.map(printNode).join('\n\n');
            return `impl ${node.name} {\n${methods}\n}`;
        }
        case "return": {
            return `return ${node.expr ? printNode(node.expr) : ''}`
        }
        default:
            return '';
    }
}