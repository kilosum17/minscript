import type { Lexer } from "../lexer/lexer";
import { Token, type TokenType } from "../lexer/lexer_types";
import { isIdent } from "../utils/char_helpers";
import { printNode2 } from "./parse_utils";
import type { AstNode, BlockDecl, FuncDecl, FuncParam, FuncParamsList, FuncType, ImplBlock, StatDecl, StructDecl, StructField, StructFieldList } from "./parser_types";
import { PrattParser, type TExpr } from "./pratt_parser";

export class Parser {
    curPos = 0
    trackingPub = false
    trackingAsync = false
    skips = 0
    pratt: PrattParser

    constructor(private lex: Lexer) {
        this.pratt = new PrattParser(lex)

        this.parseAll()
    }

    parseAll() {
        let i = 0
        while (true) {
            const p1 = this.peek(this.skips)
            console.log('KWD', p1.type, this.skips)

            this.tryParseComment()

            let kwd = p1.type

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
            console.log(printNode2(node!))
            if (i++ > 10) {
                break
            }
        }
    }

    next(): Token {
        return this.lex.next()
    }

    peek(n = 0): Token {
        return this.lex.peek(n)
    }

    expect(kind: TokenType, tok?: Token): Token {
        const n = tok || this.lex.next()
        if (n.type !== kind) {
            this.lex.expect(kind)
        }
        return n
    }

    parsePackageDecl(): AstNode {
        this.expect('package')
        const n1 = this.next()
        return { kind: 'PackageDecl', name: n1.val }
    }

    parseImportDecl(): AstNode {
        this.next()
        const n1 = this.expect('"')
        const parts = []
        let cur = this.next()
        while (isIdent(cur.val) || cur.val == ".") {
            parts.push(cur.val)
            cur = this.next()
        }
        this.expect('"', cur)
        return {
            kind: 'ImportDecl', path: parts.join('')
        }
    }

    parseFuncDecl(): FuncDecl {
        let n1 = this.next()
        let is_public = false
        let is_async = false
        if (n1.type === 'pub') {
            is_public = true
            n1 = this.next()
        }
        if (n1.type === 'async') {
            is_async = true
            n1 = this.next()
        }
        this.expect('fun', n1)

        const n2 = this.expect('ID')
        const name = n2.val
        const n3 = this.expect('(')
        const params = this.parseParamsList()
        const n4 = this.expect(')')

        const p1 = this.peek()
        let return_: FuncType
        if (p1.val == '->') {
            this.next()
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

    parseParamsList(): (FuncParamsList) {
        if (this.peek().val === ')') {
            return { kind: 'ParamsList', params: [] }
        }
        let params: (FuncParam)[] = [
            this.parseParam()
        ]
        let cur = this.peek()
        while (cur.val == ',') {
            this.next()
            params.push(this.parseParam())
            cur = this.peek()
        }
        // console.log(params)
        return { kind: 'ParamsList', params }
    }

    parseParam(): (FuncParam) {
        let n1 = this.next()
        if (n1.val == "&" || n1.val === 'mut' || n1.val === 'this') {
            let is_borrow = false
            if (n1.val === '&') {
                is_borrow = true
                n1 = this.next()
            }
            let is_muttable = false
            if (n1.type === 'mut') {
                is_muttable = true
                n1 = this.next()
            }
            this.expect('this', n1)
            return { kind: 'Param', name: 'this', is_receiver: true, is_borrow, is_muttable }
        } else {
            this.expect(`ID`, n1)
            const n2 = this.expect(":")
            const type = this.parseType()
            return {
                kind: 'Param', name: n1.val, type, is_receiver: false,
                is_borrow: false, is_muttable: false,
            }
        }
    }

    parseType(): (FuncType) {
        const n1 = this.expect('ID')
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
        this.next()
        while (!this.peek().nl_before) {
            this.next()
        }
        return true
    }

    parseStruct(): StructDecl {
        let n1 = this.next()
        let is_public = false
        if (n1.type === 'pub') {
            is_public = true
            n1 = this.next()
        }
        this.expect('type', n1)
        const n2 = this.expect('ID')
        const n3 = this.expect('=')
        const fields = this.parseStructFieldList()
        return { kind: 'StructDecl', name: n2.val, fields, is_public, generics: [] }
    }

    parseStructFieldList(): StructFieldList {
        const n1 = this.expect('{')
        const fields: (StructField)[] = [
            this.parseStructField()
        ]
        while (this.peek().val != '}') {
            fields.push(this.parseStructField())
        }
        const n2 = this.expect('}')
        return { kind: 'StructFieldList', fields }
    }

    parseStructField(): StructField {
        let n1 = this.next()
        let is_public = false
        if (n1.type === 'pub') {
            is_public = true
            n1 = this.next()
        }
        this.expect('ID', n1)
        const n3 = this.expect(':')
        const type_ = this.parseType()
        if (this.peek().val == ',') {
            this.next()
        }
        console.log("Done", n1.val)
        return { kind: 'StructField', is_public, name: n1.val, type: type_ }
    }

    parseImplBlock(): ImplBlock {
        let n1 = this.expect('impl')
        let n2 = this.expect('ID')
        let n3 = this.expect('{')

        const methods = [] as (FuncDecl)[]
        while (this.peek().val != '}') {
            this.tryParseComment()
            methods.push(this.parseFuncDecl())
        }

        const n4 = this.expect('}')
        return { kind: 'ImplBlock', name: n2.val, interfaces: [], methods }
    }


    parserBlock(): BlockDecl {
        const n1 = this.expect('{')

        const stats = [] as (TExpr | StatDecl)[]
        let i = 0
        while (this.peek().val != '}') {
            const stat = this.parserStatement()
            console.log(printNode2(stat))
            stats.push(stat)
            // bre
            // if (i++ > 3) break
        }

        this.next()

        return { kind: 'BlockDecl', statements: stats }
    }

    parserStatement(): TExpr | StatDecl {
        const p1 = this.peek()
        const p2 = this.peek(1)
        if (p1.type == 'return') {
            this.expect('return')
            let expr
            if (this.peek().type == ';' || this.peek().type == '}' || this.peek().nl_before) {
                expr = null
            } else {
                expr = this.pratt.parse_expr(0)
            }
            return { kind: 'return', expr }
        } else if (p1.type == "let" || p1.type === 'var') {
            console.log("Run let/var binding")
            return this.parsseBinding()
        } else {
            const path = this.peekPath('sts')
            if (path) {
                const assigns = ["=", "+=", '-=', '*=', '/=', '%=']
                const binds = [":=", ":=="]
                if (binds.includes(this.peek(path.len).val)) {
                    console.log("Run binding")
                    return this.parsseBinding(path)
                } else if (assigns.includes(this.peek(path.len).val)) {
                    return this.parseAssign(path)
                } else {
                    return this.pratt.parse_expr(0)
                }
            } else {
                console.log('path', p1.val, p2.val)
                this.lex.expect('STOP')
            }
        }
    }

    parsseBinding(path?: ReturnType<typeof this.peekPath>): StatDecl {
        let is_short = !!path
        if (is_short) {
            const n1 = this.expect('ID')
            const n2 = this.next()
            let is_muttable
            if (n2.type === ':=') {
                is_muttable = false
            } else if (n2.type === ':==') {
                is_muttable = true
            } else {
                this.lex.expect(':=')
            }
            const rhs = this.pratt.parse_expr(0)
            if (this.peek().type == ';') this.next()
            const lhs = { name: n1.val, }
            return { kind: 'binding', is_muttable, is_short, lhs, rhs }
        } else {
            const n1 = this.next()
            let is_muttable
            if (n1.type == 'let') {
                is_muttable = false
            } else if (n1.type === 'var') {
                is_muttable = true
            } else {
                this.lex.expect('let')
            }

            const n2 = this.expect('ID')
            const n3 = this.expect('=')
            const rhs = this.pratt.parse_expr(0)
            if (this.peek().type == ';') this.next()
            const lhs = { name: n2.val, }
            return { kind: 'binding', is_muttable, is_short, lhs, rhs }
        }
    }

    parseAssign(path?: ReturnType<typeof this.peekPath>): StatDecl {
        const lhs = this.pratt.parse_expr(0)
        this.expect('=')
        const rhs = this.pratt.parse_expr(0)
        return { kind: 'assign', lhs, rhs }
    }

}
