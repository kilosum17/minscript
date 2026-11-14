import type { Lexer } from "../lexer/lexer";
import type { Span } from "../lexer/lexer_types";
import type { AstNode, AstSpan, AstType, BlockDecl, Expr, FuncDecl, FuncParam, GenericsDecl, ImportDecl, PackageDecl, StmtDecl, StructDecl, StructField, StructFieldsList, UnionDecl, UnionItem } from "./ast_types";
import { printAstNode } from "./ast_utils";
import { Pratt } from "./pratt";

export class Parser {
    nodes = [] as AstNode[]
    pratt: Pratt

    constructor(
        private lex: Lexer
    ) {
        this.pratt = new Pratt(this, lex)
    }

    parse() {
        this.nodes = []

        while (true) {
            const node = this.getNode()
            if (!node) {
                break
            }
            console.log(printAstNode(node))
        }

    }

    private starts = [] as number[]
    saveStart() {
        const start = this.lex.peek(1).span.start
        this.starts.push(start)
    }
    getSpan(): AstSpan {
        const start = this.starts.pop()
        if (start == undefined) throw new Error('Getting unsaved start:' + this.lex.peek().val)
        return { start, end: this.lex.peek().span.end }
    }

    getNode(): AstNode {
        let offset = 0
        while (true) {
            const p1 = this.lex.peek(offset)
            const kwd = p1.kwd()
            if (kwd === 'pub' || kwd == 'async') {
                offset++
                continue
            } else {
                offset = 0
            }
            if (kwd == 'package') {
                return this.parsePackageDecl()
            } else if (kwd == 'import') {
                return this.parseImportDecl()
            } else if (kwd === 'type') {
                return this.parseStruct()
            } else if (kwd === 'union') {
                return this.parseUnionDecl()
            } else if (kwd === 'fn') {
                return this.parseFuncDecl()
            }

            throw new Error(`Unkown type: ${offset} ${kwd} ${this.lex.peek(1).val} ${this.lex.peek(2).val}`)
        }
    }

    private parsePackageDecl(): PackageDecl {
        this.saveStart()
        this.lex.expect('package')
        const n1 = this.lex.expect('ID')
        return {
            kind: 'PackageDecl', name: n1.val,
            span: this.getSpan()
        }
    }

    private parseImportDecl(): ImportDecl {
        this.saveStart()
        this.lex.expect('import')
        let is_pub = false
        if (this.lex.peek().kwd() === 'pub') {
            is_pub = true
            this.lex.expect('pub')
        }
        this.lex.expect("STR_START")
        const n1 = this.lex.expect('STR_PART')
        this.lex.expect('STR_END')
        let alias = undefined as string | undefined
        if (this.lex.peek().kwd() === 'as') {
            this.lex.expect('as')
            alias = this.lex.expect('ID').val
        }
        return {
            kind: 'ImportDecl', is_pub, alias, path: n1.val,
            span: this.getSpan()
        }
    }

    private parseStruct(): StructDecl {
        this.saveStart()
        let is_pub = false
        let n1 = this.lex.next()
        if (n1.kwd() === 'pub') {
            is_pub = true
            n1 = this.lex.next()
        }
        this.lex.expect('type', n1)
        const name = this.lex.expect('ID').val
        const generics = this.tryParseGenerics()
        const fields_list = this.parseStructFieldsList()
        return {
            kind: 'StructDecl', name, generics, fields_list,
            span: this.getSpan(), is_pub,
        }
    }

    private tryParseGenerics(): GenericsDecl | undefined {
        // throw new Error('TODO')
        if (this.lex.peek().val !== '[') return
        this.saveStart()
        this.lex.expect_('[')
        const items = [] as AstType[]
        while (this.lex.peek().val != ']') {
            this.saveStart()
            const item = this.parseType()
            items.push(item)
            // console.log("GenItem", item)
            if (this.lex.peek().symb() != ']') this.lex.expect_(',')
        }
        this.lex.expect_(']')
        return { kind: 'GenericDecl', items, span: this.getSpan() }
    }

    private parseStructFieldsList(): StructFieldsList {
        this.saveStart()
        this.lex.expect_('{')
        let fields = [] as (StructField | FuncDecl)[]
        while (this.lex.peek().val != '}') {
            const p1 = this.lex.peek()
            const p2 = this.lex.peek(1)
            if (
                p1.kwd_('fn') || (p1.kwd_('pub') && p2.kwd_('fn'))
            ) {
                fields.push(this.parseFuncDecl())
            } else {
                fields.push(this.parseStructField())
            }
        }
        this.lex.expect_('}')
        return { kind: "StructFieldsList", fields, span: this.getSpan() }
    }

    private parseStructField(): StructField {
        this.saveStart()
        let is_pub = false
        if (this.lex.peek().kwd() === 'pub') is_pub = true
        const name = this.lex.expect('ID').val
        this.lex.expect_(':')
        const type = this.parseType()
        const init = undefined
        if (this.lex.peek().val == ',') this.lex.next()
        return {
            kind: 'StructField', is_pub, name, type, init,
            span: this.getSpan()
        }
    }

    private parseType(): AstType {
        this.saveStart()
        const name = this.lex.expect('ID').val
        const generics = this.tryParseGenerics()
        let is_option = false
        if (this.lex.peek().symb() == '?') {
            is_option = true
            this.lex.expect_('?')
        }
        return {
            kind: 'AstType', name, generics, is_option,
            span: this.getSpan()
        }
    }

    private parseUnionDecl(): UnionDecl {
        this.saveStart()
        let n1 = this.lex.next()
        let is_pub = false
        if (n1.kwd() == 'pub') {
            is_pub = true
            n1 = this.lex.next()
        }
        this.lex.expect('union', n1)
        const name = this.lex.expect('ID').val
        const generics = this.tryParseGenerics()
        this.lex.expect_('{')
        const vars = [] as (UnionItem)[]
        const methods = [] as FuncDecl[]
        while (!this.lex.peek().symb_('}')) {
            const p1 = this.lex.peek()
            const p2 = this.lex.peek(1)

            if (p1.kwd() === 'fn' || p1.kwd() === 'pub') {
                const fun = this.parseFuncDecl()
                methods.push(fun)
            } else if (p1.type === 'ID') {
                if (p2.val == '{') {
                    this.saveStart()
                    const name = this.lex.expect('ID').val
                    const fields_list = this.parseStructFieldsList()
                    vars.push({
                        kind: 'UnionStruct', name, fields_list, span: this.getSpan()
                    })
                } else if (p2.val == '(') {
                    this.saveStart()
                    const name = this.lex.expect('ID').val
                    this.lex.expect_('(')
                    const items2 = [] as AstType[]
                    while (this.lex.peek().val != ')') {
                        const type = this.parseType()
                        items2.push(type)
                        if (this.lex.peek().val != ')') this.lex.expect_(',')
                    }
                    this.lex.expect_(')')
                    vars.push({ kind: 'UnionTuple', name, items: items2, span: this.getSpan(), })
                } else if (p2.nl_before) {
                    this.saveStart()
                    const name = this.lex.expect('ID').val
                    vars.push({ kind: 'UnionBare', name, span: this.getSpan() })
                } else {
                    throw new Error('Unkown union field member')
                }
            } else {
                console.log('logg', { items: vars, methods })
                throw new Error(`Unkown union member ${p1.val} ${p2.val}`)
            }
        }
        this.lex.expect_('}')
        return { kind: 'UnionDecl', name, generics, is_pub, methods, vars, span: this.getSpan() }
    }

    private parseFuncDecl(): FuncDecl {
        this.saveStart()
        let is_pub = false;
        let n1 = this.lex.next()
        if (n1.kwd() === 'pub') {
            is_pub = true
            n1 = this.lex.next()
        }
        this.lex.expect('fn', n1)
        const name = this.lex.expect('ID').val
        const generics = this.tryParseGenerics()
        const params = this.parseFuncParams()
        let ret = undefined as undefined | AstType
        if (this.lex.peek().symb_('->')) {
            this.lex.expect_('->')
            ret = this.parseType()
        }
        const block = this.parseBlockDecl()
        return { kind: 'FuncDecl', name, is_pub, params, return: ret, generics, block }
    }

    private parseFuncParams(): FuncParam[] {
        this.saveStart()
        this.lex.expect_('(')
        const params = [] as FuncParam[]
        while (this.lex.peek().val != ')') {
            const p1 = this.lex.peek()
            const p2 = this.lex.peek(1)
            if (p1.kwd_('this') || (p1.val_('*') && p2.kwd_('this'))) {
                if (p1.val_('*')) {
                    this.lex.expect_('*')
                    this.lex.expect('this')
                    params.push({ kind: 'FuncParam', name: 'this', is_mut: true })
                } else {
                    this.lex.expect('this')
                    params.push({ kind: 'FuncParam', name: 'this', is_mut: false })
                }
            } else if (p1.type_('ID')) {
                const name = this.lex.expect('ID').val
                this.lex.expect_(':')
                let is_mut = false
                if (this.lex.peek().symb_('*')) {
                    is_mut = true
                    this.lex.expect_('*')
                }
                const type = this.parseType()
                params.push({ kind: 'FuncParam', name, is_mut, type })
            }
            if (this.lex.peek().symb_(',')) {
                this.lex.expect_(',')
                if (this.lex.peek().symb_(')')) break
            }
        }
        this.lex.expect_(')')
        return params
    }

    private parseBlockDecl(): BlockDecl {
        this.lex.expect_('{')
        let depth = 1
        while (true) {
            const p1 = this.lex.peek()
            if (p1.val === '{') {
                depth++
            }
            if (p1.val == '}') {
                depth--
                if (depth == 0) break
            }
            this.lex.next()
        }
        this.lex.expect_('}')
        // console.log('Done', this.lex.peek().value, this.lex.peek(1).value)
        return { kind: 'BlockDecl', items: [] }
    }

}