import type { Lexer } from "../lexer/lexer";
import { Token } from "../lexer/lexer_types";
import { isIdent } from "../utils/char_helpers";
import { strNode } from "./parse_utils";
import type { ArgsList, AstError, AstNode, BlockDecl, ExprDecl, FuncDecl, FuncParam, FuncParamsList, FuncType, ImplBlock, StatDecl, StructDecl, StructField, StructFieldList } from "./parser_types";
import { PrattParser } from "./pratt_parser";

export class Parser {
    nodes: AstNode[] = []
    curPos = 0
    trackingPub = false
    trackingAsync = false
    skips = 0
    pratt: PrattParser

    constructor(private lexer: Lexer) {
        this.pratt = new PrattParser(lexer)
        
        this.parseAll()
    }

    parseAll() {
        let i = 0
        while (true) {
            const pk1 = this.peek(this.skips)
            console.log('KWD', pk1.getKwd(), this.skips)

            this.tryParseComment()

            if (pk1.kind == 'KWD') {
                let kwd = pk1.getKwd()

                if (kwd == 'pub') {
                    this.skips++
                    this.trackingPub = true
                    continue
                } else {
                    this.trackingPub = false
                }
                if (kwd === 'async') {
                    this.skips++
                    this.trackingAsync = true
                    continue
                } else {
                    this.trackingAsync = false
                }

                let node
                if (kwd === 'package') {
                    node = this.parsePackageDecl()
                } else if (kwd === 'import') {
                    node = this.parseImportDecl()
                } else if (kwd === 'fun') {
                    this.skips = 0
                    node = this.parseFuncDecl()
                } else if (kwd === 'type') {
                    this.skips = 0
                    node = this.parseStruct()
                } else if (kwd === 'impl') {
                    node = this.parseImplBlock()
                }
                console.log(strNode(node!))
            } else {
                // console.log('Unkown', pk1.lexeme)
            }
            if (i++ > 10) {
                break
            }
        }
    }

    getNext(): Token {
        const tok = this.lexer.tokens[this.curPos] || new Token()
        this.curPos++
        return tok
    }

    peek(n = 0): Token {
        return this.lexer.tokens[this.curPos + n] || new Token()
    }

    skip(n = 1) {
        this.curPos += n
    }

    expect(expected: string, tok: Token): AstError {
        const extra = ` [${this.peek(-1).val}, ${this.peek(0).val}, ${this.peek(1).val}] `
        const message = `Expected '${expected}' got '${tok.val}' ${extra}`
        return { kind: 'Error', message }
    }

    parsePackageDecl(): AstNode {
        this.getNext()
        const n1 = this.getNext()
        return { kind: 'PackageDecl', name: n1.val }
    }

    parseImportDecl(): AstNode {
        this.getNext()
        const n1 = this.getNext()
        if (n1.val !== '"') {
            return {
                kind: "Error", recoverBefore: [],
                message: `import paths must be quoted eg 'import "std.log"' got ${n1.val} `
            }
        }
        const parts = []
        let cur = this.getNext()
        while (isIdent(cur.val) || cur.val == ".") {
            parts.push(cur.val)
            cur = this.getNext()
        }
        if (cur.val != '"') {
            return this.expect(`["]`, n1)
        }
        return {
            kind: 'ImportDecl', path: parts.join('')
        }
    }

    parseFuncDecl(): FuncDecl | AstError {
        let n1 = this.getNext()
        let is_public = false
        let is_async = false
        if (n1.getKwd() === 'pub') {
            is_public = true
            n1 = this.getNext()
        }
        if (n1.getKwd() === 'async') {
            is_async = true
            n1 = this.getNext()
        }
        if (n1.getKwd() !== 'fun') {
            return this.expect('fun', n1)
        }
        const n2 = this.getNext()
        if (!isIdent(n2.val)) {
            return this.expect('identifier', n2)
        }
        const name = n2.val
        const n3 = this.getNext()
        if (n3.val !== '(') {
            return this.expect('(', n3)
        }
        const params = this.parseParamsList()
        const n4 = this.getNext()
        if (n4.val != ')') {
            return this.expect(')', n4)
        }

        const p1 = this.peek()
        let return_: FuncType | AstError
        if (p1.val == '->') {
            this.getNext()
            return_ = this.parseType()
        } else {
            return_ = { kind: 'Type', name: 'void', generics: [] }
        }

        const block = this.parserBlock()

        return {
            kind: 'FuncDecl', name, is_public, is_async,
            params, return: return_, block
        }
    }

    parseParamsList(): (FuncParamsList | AstError) {
        if (this.peek().val === ')') {
            return { kind: 'ParamsList', params: [] }
        }
        let params: (FuncParam | AstError)[] = [
            this.parseParam()
        ]
        let cur = this.peek()
        while (cur.val == ',') {
            this.getNext()
            params.push(this.parseParam())
            cur = this.peek()
        }
        // console.log(params)
        return { kind: 'ParamsList', params }
    }

    parseParam(): (FuncParam | AstError) {
        let n1 = this.getNext()
        if (n1.val == "&" || n1.val === 'mut' || n1.val === 'this') {
            let is_borrow = false
            if (n1.val === '&') {
                is_borrow = true
                n1 = this.getNext()
            }
            let is_muttable = false
            if (n1.getKwd() === 'mut') {
                is_muttable = true
                n1 = this.getNext()
            }
            if (n1.getKwd() !== 'this') {
                return this.expect('this', n1)
            }
            return { kind: 'Param', name: 'this', is_receiver: true, is_borrow, is_muttable }
        } else {
            if (!isIdent(n1.val)) {
                return this.expect(`identifier`, n1)
            }
            const n2 = this.getNext()
            if (n2.val != ':') {
                return this.expect(`:`, n2)
            }
            const type = this.parseType()
            return {
                kind: 'Param', name: n1.val, type, is_receiver: false,
                is_borrow: false, is_muttable: false,
            }
        }
    }

    parseType(): (FuncType | AstError) {
        const n1 = this.getNext()
        if (!isIdent(n1.val)) {
            return this.expect('identifier', n1)
        }
        const name = n1.val
        return { kind: 'Type', name, generics: [] }
    }

    peekPath(log_mes?: string) {
        let idx = 0
        const n1 = this.peek(idx)
        if (!isIdent(n1.val)) return false
        let parts = [n1.val]
        idx += 1
        let prevIsDot = false
        while (true) {
            const part = this.peek(idx).val
            const isDot = part === '.'
            if (isDot && !prevIsDot) {
                parts.push(part)
            } else if (prevIsDot && isIdent(part)) {
                parts.push(part)
            } else {
                break
            }
            prevIsDot = isDot
            idx += 1
        }
        console.log(`Path: ${log_mes || ''} ` + parts.join(''), parts.length)
        return { path: parts.join(''), len: parts.length }
    }

    tryParseComment(): boolean {
        const p1 = this.peek(0)
        if (p1.val != '//') {
            return false
        }
        this.getNext()
        while (!this.peek().nl_before) {
            this.getNext()
        }
        return true
    }

    parseStruct(): StructDecl | AstError {
        let n1 = this.getNext()
        let is_public = false
        if (n1.getKwd() === 'pub') {
            is_public = true
            n1 = this.getNext()
        }
        if (n1.getKwd() != 'type') {
            return this.expect('type', n1)
        }
        const n2 = this.getNext()
        if (!isIdent(n2.val)) {
            return this.expect('identifier', n2)
        }
        const n3 = this.getNext()
        if (n3.val !== '=') {
            return this.expect("=", n3)
        }
        const fields = this.parseStructFieldList()
        return { kind: 'StructDecl', name: n2.val, fields, is_public, generics: [] }
    }

    parseStructFieldList(): StructFieldList | AstError {
        const n1 = this.getNext()
        if (n1.val != "{") {
            return this.expect("{", n1)
        }
        const fields: (StructField | AstError)[] = [
            this.parseStructField()
        ]
        while (this.peek().val != '}') {
            fields.push(this.parseStructField())
        }
        const n2 = this.getNext()
        if (n2.val != '}') {
            return this.expect("}", n2)
        }
        return { kind: 'StructFieldList', fields }
    }

    parseStructField(): StructField | AstError {
        let n1 = this.getNext()
        let is_public = false
        if (n1.getKwd() === 'pub') {
            is_public = true
            n1 = this.getNext()
        }
        if (!isIdent(n1.val)) {
            return this.expect('identifier', n1)
        }
        const n3 = this.getNext()
        // console.log({ n1, is_public, n3 })

        if (n3.val != ':') {
            return this.expect(':', n3)
        }
        const type_ = this.parseType()
        if (this.peek().val == ',') {
            this.getNext()
        }
        console.log("Done", n1.val)
        return { kind: 'StructField', is_public, name: n1.val, type: type_ }
    }

    parseImplBlock(): ImplBlock | AstError {
        let n1 = this.getNext()
        if (n1.val !== 'impl') {
            return this.expect("impl", n1)
        }

        let n2 = this.getNext()
        if (!isIdent(n2.val)) {
            return this.expect("identifier", n2)
        }
        let n3 = this.getNext()
        if (n3.val != '{') {
            return this.expect("{", n3)
        }


        const methods = [] as (FuncDecl | AstError)[]
        while (this.peek().val != '}') {
            this.tryParseComment()
            methods.push(this.parseFuncDecl())
        }

        const n4 = this.getNext()
        if (n4.val != '}') {
            return this.expect("}", n4)
        }
        return { kind: 'ImplBlock', name: n2.val, interfaces: [], methods }
    }


    parserBlock(): BlockDecl | AstError {
        const n1 = this.getNext()
        if (n1.val != '{') {
            return this.expect('{', n1)
        }

        const stats = [] as (ExprDecl | StatDecl | AstError)[]
        let i = 0
        while (this.peek().val != '}') {
            const stat = this.parserStatement()
            stats.push(stat)
            // bre
            if (i++ > 3) break
        }

        this.getNext()

        return { kind: 'BlockDecl', statements: stats }
    }

    parserStatement(): ExprDecl | StatDecl | AstError {
        const p1 = this.peek()
        const p2 = this.peek(1)
        if (p1.getKwd() == "let" || p1.getKwd() === 'var') {
            return this.parsseBinding()
        } else {
            const path = this.peekPath('sts')
            if (path) {
                const assigns = ["=", "+=", '-=', '*=', '/=', '%=']
                const binds = [":=", ":=="]
                if (binds.includes(this.peek(path.len + 1).val)) {
                    return this.parsseBinding(path)
                } else if (assigns.includes(this.peek(path.len + 1).val)) {
                    return this.parseAssign(path)
                } else {
                    return this.parseExpresion()
                }
            } else {
                return { kind: "Error", message: 'TODO -no-path' }
            }
        }
    }

    parsseBinding(path?: ReturnType<typeof this.peekPath>): StatDecl | AstError {
        let is_short = !!path
        if (is_short) {

        } else {
            const n1 = this.getNext()
            let is_muttable
            if (n1.val == 'let') {
                is_muttable = false
            } else if (n1.val === 'var') {
                is_muttable = true
            } else {
                return this.expect('var or let', n1)
            }

            const n2 = this.getNext()
            if (!isIdent(n2.val)) return this.expect('identifier', n2)
            const n3 = this.getNext()
            if (n3.val != '=') return this.expect('=', n3)
            const expr = this.parseExpresion()
        }
        return { kind: 'Error', message: 'TODO binding' }
    }

    parseAssign(): AstError {
        return { kind: 'Error', message: 'TODO assign' }
    }

    parseExpresion(): ExprDecl | AstError {
        console.log('exp_s', this.peek().val)
        if (this.peek().val == '"') {
            return this.parseStringExpr()
        } else {
            // return this.expect('TODO', this.peek(), )
            const path = this.peekPath('Desa')
            if (path) {
                if (this.peek(path.len).val === '(') {
                    console.log('bf sk', path.len, path.path)
                    this.skip(path.len)
                    console.log('after sk', this.peek().val)
                    this.getNext()
                    const args = this.parseArgList()
                    const n1 = this.getNext()
                    if (n1.val != ')') return this.expect(')', n1)
                    return { kind: 'call', path: path.path, args }
                } else if (this.peek(path.len).val === '}') {
                    this.skip(path.len)
                    const lhs = path.path
                    return { kind: 'expr', lhs }
                }
            }
            return { kind: 'Error', message: 'TODO exp-nos' }
        }
    }

    parseArgList(): ArgsList | AstError {
        if (this.peek().val == ')') return { kind: "ArgsList", args: [] }

        const args = [] as (ExprDecl | AstError)[]
        let isStart = true
        while (true) {
            console.log('args-22', args, this.peek().val)
            args.push(this.parseExpresion())
            if (this.peek().val == ')') {
                break;
            }
            if (isStart) isStart = false
            else {
                const n1 = this.getNext()
                if (n1.val !== ',') {
                    return this.expect(', or )', n1)
                }
                if (this.peek().val === ')') {
                    break
                }
            }
        }
        return { kind: 'ArgsList', args }
    }

    parseStringExpr(): ExprDecl | AstError {
        console.log('str_ss')

        const n1 = this.getNext()
        if (n1.val != '"') return this.expect('"', n1)
        let parts = [] as (string | ExprDecl | AstError)[]
        while (this.peek().val != '"') {
            const p1 = this.peek(1)
            if (this.peek().val === '$' && p1.val === '{' && !p1.ws_before) {
                this.skip(2)
                console.log('fed-2', this.peek().val)
                parts.push(this.parseExpresion())
                const n2 = this.getNext()
                console.log({ parts, n2: n2.val })
                if (n2.val != '}') return this.expect('}', n2)
            } else {
                const n3 = this.getNext()
                console.log({ n3: n3.val, p1: p1.val })
                parts.push(n3.val)
            }
        }
        const n4 = this.getNext()
        if (n4.val != '"') return this.expect('"', n4)
        console.log('Afters', { n4: n4.val })
        return { kind: 'str_expr', parts }
    }

}
