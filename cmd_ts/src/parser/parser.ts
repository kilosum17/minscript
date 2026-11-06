import type { Lexer } from "../lexer/lexer";
import { Token, type TokenType } from "../lexer/lexer_types";
import { isIdent } from "../utils/char_helpers";
import { printNode2 } from "./parse_utils";
import type { AstNode, BlockDecl, FuncDecl, FuncParam, FuncParamsList, FuncType, GenericItem, ImplBlock, InterBlock, StatDecl, StructDecl, StructField, StructFieldList, UnionDecl, UnionField, UnionFieldList } from "./parser_types";
import { PrattParser, type TExpr } from "./pratt_parser";

export const assigns = ["=", "+=", '-=', '*=', '/=', '%=']


export class Parser {
    curPos = 0
    trackingPub = false
    trackingAsync = false
    skips = 0
    pratt: PrattParser

    constructor(private lex: Lexer) {
        this.pratt = new PrattParser(lex, this)

        this.parseAll()
    }

    parseAll() {
        let i = 0
        while (true) {
            this.tryParseComment()

            const p1 = this.peek(this.skips)
            console.log('KWD', p1.type, this.skips)

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
            } else if (kwd === 'union') {
                this.skips = 0
                node = this.parseUnion()
            } else if (kwd === 'inter') {
                this.skips = 0
                node = this.parseInterBlock()
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

    expectVal(val: string, tok?: Token): Token {
        const n = tok || this.lex.next()
        if (n.val !== val) this.lex.expect(val)
        return n
    }

    parsePackageDecl(): AstNode {
        this.expect('package')
        const n1 = this.next()
        return { kind: 'PackageDecl', name: n1.val }
    }

    parseImportDecl(): AstNode {
        this.expect('import')
        this.expect('"')
        const n1 = this.next()
        this.expect('"')
        let rename = ""
        if (this.lex.peek().val === 'as') {
            this.expect('as')
            const n1 = this.expect('ID')
            rename = n1.val
        }
        return {
            kind: 'ImportDecl', path: n1.val, rename,
        }
    }

    parseFuncDecl(no_body_ok = false): FuncDecl {
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
        const generics = this.tryParseGenerics()
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

        let block = undefined as undefined | BlockDecl
        if (!(no_body_ok && this.lex.peek().type != '{')) {
            block = this.parserBlock()
        }

        return {
            kind: 'FuncDecl', name, is_public, is_async,
            params, return: return_, block, generics,
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
            this.expectVal('this', n1)
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

    parseType(): FuncType {
        const n1 = this.expect('ID')
        const name = n1.val
        const generics = this.tryParseGenerics()
        return { kind: 'Type', name, generics }
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
        const generics = this.tryParseGenerics()
        this.expect('=')
        const fields = this.parseStructFieldList()
        return { kind: 'StructDecl', name: n2.val, fields, is_public, generics }
    }

    parseStructFieldList(): StructFieldList {
        const n1 = this.expect('{')
        const fields: (StructField)[] = []
        while (this.peek().val != '}') {
            fields.push(this.parseStructField())
        }
        this.expect('}')
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

    parseUnion(): UnionDecl {
        let n1 = this.next()
        let is_public = false
        if (n1.type === 'pub') {
            is_public = true
            n1 = this.next()
        }
        this.expect('union', n1)
        const n2 = this.expect('ID')
        const generics = this.tryParseGenerics()
        this.expect('=')
        const fields = this.parseUnionFieldList()
        return { kind: 'UnionDecl', name: n2.val, fields, is_public, generics }

    }

    parseUnionFieldList(): UnionFieldList {
        this.expect('{')
        const fields: (UnionField)[] = []
        while (this.peek().val != '}') {
            fields.push(this.parseUnionField())
        }
        this.expect('}')
        return { kind: 'UnionFieldList', fields }
    }
    parseUnionField(): UnionField {
        const n1 = this.expect('ID')
        const name = n1.val
        if (this.lex.peek().type == '(') {
            this.expect('(')
            let items = [] as { type: FuncType }[]
            while (this.lex.peek().type != ')') {
                const type = this.parseType()
                items.push({ type })
                if (this.peek().type == ',') {
                    this.expect(',')
                }
            }
            this.expect(')')
            return { kind: 'UnionField', name, data: { type: 'tuple', items } }
        } else if (this.lex.peek().type == '{') {
            const fields = this.parseStructFieldList()
            return { kind: 'UnionField', name, data: { type: 'struct', fields } }
        } else {
            return { kind: 'UnionField', name, data: { type: 'plain' } }
        }
    }

    parseImplBlock(): ImplBlock {
        this.expect('impl')
        let n2 = this.expect('ID')
        const generics = this.tryParseGenerics()
        this.expect('{')

        const methods = [] as (FuncDecl)[]
        while (this.peek().val != '}') {
            this.tryParseComment()
            methods.push(this.parseFuncDecl())
        }

        this.expect('}')
        return { kind: 'ImplBlock', name: n2.val, interfaces: [], generics, methods }
    }


    parserBlock(skip_start = false): BlockDecl {
        if (!skip_start) this.expect('{')

        const stats = [] as (TExpr | StatDecl)[]
        let i = 0
        while (this.peek().val != '}') {
            this.tryParseComment()
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
        if (p1.type === 'if' || p1.type === 'for' || p1.type === 'match') {
            return this.pratt.parse_block_like()
        }
        if (p1.type === 'break' || p1.type === 'continue') {
            return this.pratt.parse_expr(0)
        }
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
            let type = undefined
            if (this.peek().type === ':') {
                this.expect(':')
                type = this.parseType()
            }
            this.expect('=')
            const rhs = this.pratt.parse_expr(0)
            if (this.peek().type == ';') this.next()
            const lhs = { name: n2.val, type }
            return { kind: 'binding', is_muttable, is_short, lhs, rhs }
        }
    }

    parseAssign(path?: ReturnType<typeof this.peekPath>): StatDecl {
        const lhs = this.pratt.parse_expr(0)
        const n1 = this.next()
        if (!assigns.some(s => n1.val === s)) this.lex.expect('=')
        // this.expect('=')
        const rhs = this.pratt.parse_expr(0)
        return { kind: 'assign', oper: n1.val, lhs, rhs }
    }

    tryParseGenerics(): GenericItem[] {
        if (this.lex.peek().type !== '[') return []
        this.expect('[')
        const generics = [] as GenericItem[]
        while (this.lex.peek().type != ']') {
            const n1 = this.next()
            if (n1.type !== 'ID' && n1.type != 'NUM') this.expect('ID', n1)
            let innerGenerics = undefined as undefined | GenericItem[]
            if (this.lex.peek().type === '[') {
                const res = this.tryParseGenerics()
                if (res.length > 0) innerGenerics = res
            }
            generics.push({ kind: 'GenericItem', name: n1.val, generics: innerGenerics })
            if (this.lex.peek().type == ',') {
                this.expect(',')
                if (this.lex.peek().type == ']') break
            }
        }
        this.expect(']')
        // console.log('generics', generics)
        return generics
    }

    parseInterBlock(): InterBlock {
        this.expect('inter')
        let n2 = this.expect('ID')
        const generics = this.tryParseGenerics()
        this.expect('=')
        this.expect('{')

        const methods = [] as (FuncDecl)[]
        while (this.peek().val !== '}') {
            this.tryParseComment()
            methods.push(this.parseFuncDecl(true))
        }

        this.expect('}')
        return { kind: 'InterBlock', name: n2.val, generics, methods }
    }

}
