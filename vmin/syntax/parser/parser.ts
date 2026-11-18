import type { Lexer } from "../lexer/lexer";
import type { Diagnostic } from "../utils/diagnostics";
import type {
    AliasDecl,
    AstNode, AstSpan, AstType, BlockDecl, Expr,
    FuncDecl, FuncParam, GenericsDecl, ImportDecl, PackageDecl,
    SelectArm,
    StmtDecl, StructDecl, StructField, StructFieldsList, UnionDecl,
    UnionItem
} from "./ast_types";
import { ParseLog, printAstNode } from "./ast_utils";
import { Pratt } from "./pratt";
import { Recover } from "./recover";

export class Parser {
    nodes = [] as AstNode[]
    pratt: Pratt
    rec: Recover
    diags: Diagnostic[] = []

    constructor(
        private lex: Lexer
    ) {
        this.pratt = new Pratt(this, lex)
        this.rec = new Recover(this, lex)

    }

    parse() {
        this.nodes = []
        this.diags = []

        while (true) {
            const node = this.getNode()
            if (node == 0) {
                console.log(`Recovering: ${this.rec.msg}`)
                continue
            }
            if (!node) {
                break
            }
            this.nodes.push(node)
            ParseLog.info(printAstNode(node))
        }

    }

    private starts = [] as number[]
    saveStart() {
        const start = this.lex.peek(1).span.start
        this.starts.push(start)
    }
    gs(): AstSpan {
        const start = this.starts.pop()
        if (start == undefined) throw new Error('Getting unsaved start:' + this.lex.peek().val)
        return { start, end: this.lex.peek().span.end }
    }

    getNode(): AstNode | null | 0 {
        return this.rec.rec(
            ['type', 'pub', 'shared', 'union', 'import', 'fn'],
            0,
            () => {

                let offset = 0
                while (true) {
                    const p1 = this.lex.peek(offset)
                    const p2 = this.lex.peek(offset + 1)
                    const p3 = this.lex.peek(offset + 2)
                    const kwd = p1.kwd()
                    if (kwd === 'pub' || kwd == 'async' || kwd === 'shared') {
                        offset++
                        continue
                    } else {
                        offset = 0
                    }
                    if (p1.type_('EOF')) break

                    if (kwd == 'package') {
                        return this.parsePackageDecl()
                    } else if (kwd == 'import') {
                        return this.parseImportDecl()
                    } else if (kwd === 'type') {
                        if (p3.val_('=')) return this.parseAlias()
                        return this.parseStruct()
                    } else if (kwd === 'union') {
                        return this.parseUnionDecl()
                    } else if (kwd === 'fn') {
                        return this.parseFuncDecl()
                    } else if (kwd == 'var' || kwd === 'let') {
                        return this.parseBinding()
                    }

                    throw new Error(`Unkown type: ${offset} ${kwd} ${this.lex.info()}`)
                }

                return null

            }
        )
    }

    private parsePackageDecl(): PackageDecl | 0 {
        return this.rec.rec(
            ['\n'],
            0,
            () => {
                this.saveStart()
                this.lex.expect('package')
                const n1 = this.lex.expect('ID', undefined, undefined, true)
                return {
                    kind: 'PackageDecl', name: n1.val,
                    span: this.gs()
                }
            })
    }

    private parseImportDecl(): ImportDecl | 0 {
        return this.rec.rec(
            ['\n'],
            0,
            () => {

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
                    span: this.gs()
                }

            }
        )
    }

    private parseStruct(): StructDecl | 0 {
        return this.rec.rec(
            ['}'],
            0,
            () => {
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
                    span: this.gs(), is_pub,
                }

            }
        )
    }

    private parseAlias(): AliasDecl {
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
        this.lex.expect_('=')
        const type = this.parseType()
        return { kind: 'AliasDecl', is_pub, name, generics, type, span: this.gs() }
    }

    private tryParseGenerics(): GenericsDecl | undefined {
        const res = this.rec.rec(
            ['=', '{'],
            0,
            () => {
                if (this.lex.peek().val !== '[') return
                this.saveStart()
                this.lex.expect_('[')
                const items = [] as AstType[]
                while (this.lex.peek().val != ']') {
                    this.saveStart()
                    const item = this.parseType()
                    items.push(item)
                    // ParseLog.info("GenItem", item)
                    if (this.lex.peek().symb() != ']') this.lex.expect_(',')
                }
                this.lex.expect_(']')
                return { kind: 'GenericDecl', items, span: this.gs() } satisfies GenericsDecl
            }
        )
        if (res === 0) return undefined
        return res
    }

    private parseStructFieldsList(): StructFieldsList {
        this.saveStart()
        this.lex.expect_('{')
        let fields = [] as (StructField | FuncDecl)[]
        while (this.lex.peek().val != '}') {
            this.rec.rec(
                ['\n'],
                0,
                () => {
                    const p1 = this.lex.peek()
                    const p2 = this.lex.peek(1)
                    const p3 = this.lex.peek(2)
                    if (
                        p1.kwd_('fn') ||
                        (p1.kwd_('pub') && p2.kwd_('fn')) ||
                        (p1.kwd_('pub') && p2.kwd_('async') && p3.kwd_('fn'))
                    ) {
                        fields.push(this.parseFuncDecl())
                    } else {
                        fields.push(this.parseStructField())
                    }
                }
            )
        }
        this.lex.expect_('}')
        return { kind: "StructFieldsList", fields, span: this.gs() }
    }

    private parseStructField(): StructField {
        this.saveStart()
        let is_pub = false
        if (this.lex.peek().kwd() === 'pub') {
            this.lex.expect('pub')
            is_pub = true
        }
        const name = this.lex.expect('ID').val
        this.lex.expect_(':')
        const type = this.parseType()
        let init = undefined as undefined | Expr
        if (this.lex.peek().val_('=')) {
            this.lex.expect_('=')
            init = this.pratt.parseExpr(0, { avoidBrace: false })
        }
        if (this.lex.peek().val == ',') this.lex.next()
        return {
            kind: 'StructField', is_pub, name, type, init,
            span: this.gs()
        }
    }

    parseType(): AstType {
        this.saveStart()
        const p1 = this.lex.peek()
        const p2 = this.lex.peek(1)
        if (p1.val_('t(')) {
            this.lex.expect_('t(')
            const items = [] as AstType[]
            while (!this.lex.peek().val_(')')) {
                items.push(this.parseType())
                if (!this.lex.peek().val_(')')) {
                    this.lex.expect_(',')
                }
            }
            this.lex.expect_(')')
            let is_option = false
            if (this.lex.peek().val_('?')) {
                is_option = true
                this.lex.expect_('?')
            }
            ParseLog.info('IN record type')
            return { kind: 'AstType', mode: 'tuple', is_option, items, span: this.gs() }
        } else if (p1.val_('r{')) {
            this.lex.expect_('r{')
            const fields = [] as { key: string, type: AstType }[]
            while (!this.lex.peek().val_('}')) {
                const key = this.lex.expect('ID').val
                this.lex.expect_(':')
                const type = this.parseType()
                fields.push({ key, type })
                if (!this.lex.peek().val_('}')) {
                    this.lex.expect_(',')
                }
            }
            this.lex.expect_('}')
            let is_option = false
            if (this.lex.peek().val_('?')) {
                is_option = true
                this.lex.expect_('?')
            }
            return { kind: 'AstType', mode: 'record', is_option, fields, span: this.gs() }
        } else if (p1.val_('(') || (p1.val_('?') && p2.val_('('))) {
            let is_option = p1.val_('?')
            if (is_option) this.lex.expect_('?')
            this.lex.expect_('(')
            const args = [] as AstType[]
            while (!this.lex.peek().val_(')')) {
                args.push(this.parseType())
                if (!this.lex.peek().val_(')')) this.lex.expect_(',')
            }
            this.lex.expect_(')')
            this.lex.expect_('->')
            const ret = this.parseType()
            return { kind: 'AstType', mode: 'func', is_option, args, ret, span: this.gs() }
        } else {
            let name = this.lex.expect('ID').val
            while (this.lex.peek().val_('.')) {
                this.lex.expect_('.')
                name += '.' + this.lex.expect('ID').val
            }
            const generics = this.tryParseGenerics()
            let is_option = false
            if (this.lex.peek().symb() == '?') {
                is_option = true
                this.lex.expect_('?')
            }
            return {
                kind: 'AstType', mode: 'var', name, generics, is_option,
                span: this.gs()
            }
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
                        kind: 'UnionStruct', name, fields_list, span: this.gs()
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
                    vars.push({ kind: 'UnionTuple', name, items: items2, span: this.gs(), })
                } else if (p2.nl_before) {
                    this.saveStart()
                    const name = this.lex.expect('ID').val
                    vars.push({ kind: 'UnionBare', name, span: this.gs() })
                } else {
                    throw new Error('Unkown union field member')
                }
            } else {
                ParseLog.info('logg', { items: vars, methods })
                throw new Error(`Unkown union member ${p1.val} ${p2.val}`)
            }
        }
        this.lex.expect_('}')
        return { kind: 'UnionDecl', name, generics, is_pub, methods, vars, span: this.gs() }
    }

    private parseFuncDecl(): FuncDecl {
        this.saveStart()
        let is_pub = false;
        let n1 = this.lex.next()
        if (n1.kwd() === 'pub') {
            is_pub = true
            n1 = this.lex.next()
        }
        let is_async = false
        if (n1.kwd_('async')) {
            is_async = true
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
        return {
            kind: 'FuncDecl', name, is_pub, is_async, params, return: ret, generics, block,
            span: this.gs()
        }
    }

    private parseFuncParams(): FuncParam[] {
        this.lex.expect_('(')
        const params = [] as FuncParam[]
        while (this.lex.peek().val != ')') {
            this.saveStart()
            const p1 = this.lex.peek()
            const p2 = this.lex.peek(1)
            if (p1.kwd_('this') || (p1.val_('*') && p2.kwd_('this'))) {
                if (p1.val_('*')) {
                    this.lex.expect_('*')
                    this.lex.expect('this')
                    params.push({ kind: 'FuncParam', name: 'this', is_mut: true, span: this.gs() })
                } else {
                    this.lex.expect('this')
                    params.push({ kind: 'FuncParam', name: 'this', is_mut: false, span: this.gs() })
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
                params.push({ kind: 'FuncParam', name, is_mut, type, span: this.gs() })
            }
            if (this.lex.peek().symb_(',')) {
                this.lex.expect_(',')
                if (this.lex.peek().symb_(')')) break
            }
        }
        this.lex.expect_(')')
        return params
    }

    parseBlockDecl(ops?: { openBraceOptional?: boolean, bracesOptional?: boolean, hasClosingBrace?: boolean }): BlockDecl {
        this.saveStart()
        let brace_optional = ops?.bracesOptional ?? false
        let open_brace_optional = ops?.openBraceOptional ?? false
        let hasClosingBrace = ops?.hasClosingBrace ?? null
        let has_open_brace = false
        if (brace_optional || open_brace_optional) {
            if (this.lex.peek().val_('{')) has_open_brace = true
        } else {
            has_open_brace = true
        }
        if (has_open_brace) this.lex.expect_('{')

        const items = [] as (StmtDecl | Expr)[]
        let loops = 0
        while (true) {
            if (has_open_brace) {
                if (this.lex.peek().val_('}')) break
            } else {
                if (hasClosingBrace != null && hasClosingBrace === true) {
                    if (this.lex.peek().val_('}')) break
                } else {
                    if (loops > 0) break
                }
            }
            this.saveStart()
            const p1 = this.lex.peek()
            const p2 = this.lex.peek(1)
            let prev_stmt = '' as 'label' | 'return' | ''
            if (p1.kwd_('return')) {
                prev_stmt = 'return'
                this.lex.expect('return')
                let expr = undefined as undefined | Expr
                if (!this.lex.peek().nl_before && !this.lex.peek().val_('}')) {
                    ParseLog.info('getting return expt', this.lex.peek().val)
                    expr = this.pratt.parseExpr(0, { avoidBrace: false })
                }
                items.push({ kind: 'Return', expr, span: this.gs() })
            } else if (p1.kwd_('continue') || p1.kwd_('break')) {
                const is_continue = p1.kwd_('continue')
                this.lex.next()
                let label = undefined as undefined | string
                if (!this.lex.peek().nl_before && this.lex.peek().type_('ID')) {
                    label = this.lex.expect('ID').val
                }
                items.push({ kind: is_continue ? 'Continue' : 'Break', label, span: this.gs() })
            } else if (p1.kwd_('var') || p1.kwd_('let') ||
                (p1.kwd_('shared') && (p2.kwd_('var') || p2.kwd_('let')))
            ) {
                const stmt = this.parseBinding()
                items.push(stmt)
            } else if (p2.val_(':=') || p2.val_(':==')) {
                const stmt = this.parseBinding()
                items.push(stmt)
            } else if (p1.kwd_('for')) {
                const stmt = this.parseForLoop()
                items.push(stmt)
            } else if (p1.type_('ID') && p2.val_(':')) {
                prev_stmt = 'label'
                const name = this.lex.expect('ID').val
                this.lex.expect_(':')
                items.push({ kind: 'Label', name, span: this.gs() })
            } else {
                const exp = this.pratt.parseExpr(0, { avoidBrace: false })
                items.push(exp)
            }

            // ParseLog.info(printAstNode(items.at(-1)!))

            if (this.lex.peek().val_(';')) {
                this.saveStart()
                this.lex.expect_(';')
                items.push({ kind: 'SemiColon', span: this.gs() })
            } else {
                if (!this.lex.peek().val_('}') &&
                    !this.lex.peek().nl_before &&
                    prev_stmt != 'label' &&
                    this.lex.peek(-1).val_('or')
                    // !this.lex.peek().val_('or')
                ) {
                    throw new Error(`More than 1 expression in a line: ${this.lex.info()}`)
                }
            }
            loops += 1
        }
        if (
            (brace_optional && has_open_brace) ||
            !brace_optional
        ) {
            // ParseLog.info('Consumed } ')
            this.lex.expect_('}')
        }
        // ParseLog.info('>>> Done', this.lex.peek().val, this.lex.peek(1).val)
        return { kind: 'BlockDecl', items, span: this.gs() }
    }

    parseBinding(): StmtDecl {
        this.saveStart()

        let is_pub = false
        if (this.lex.peek().kwd_('pub')) {
            is_pub = true
            this.lex.expect('pub')
        }

        let is_shared = false
        if (this.lex.peek().kwd_('shared')) {
            is_shared = true
            this.lex.expect('shared')
        }

        const p1 = this.lex.peek()
        const p2 = this.lex.peek(1)

        let is_short = false
        let is_mut = false
        if (p1.kwd_('var') || p1.kwd_('let')) {
            is_short = false
            is_mut = p1.kwd_('var')
            this.lex.next()
        } else if (p2.val_(':==') || p2.val_(':=')) {
            is_short = true
            is_mut = p2.val_(':==')
        } else {
            throw new Error('Unkown binding format')
        }

        let name = undefined as undefined | string
        let bind_expr = undefined as undefined | Expr
        if (is_short) {
            name = this.lex.expect('ID').val
            this.lex.next() // consume :=
        } else {
            if (this.lex.peek().type_('ID') &&
                (this.lex.peek(1).val_('=') || this.lex.peek(1).val_(':'))
            ) {
                name = this.lex.expect('ID').val
            } else {
                bind_expr = this.pratt.parseExpr(0, { avoidBrace: false, avoidAssign: true })
            }
        }

        let type = undefined as undefined | AstType
        if (!is_short && this.lex.peek().val_(':')) {
            this.lex.expect_(':')
            type = this.parseType()
        }

        let has_expr = false
        if (is_short) {
            has_expr = true
        } else {
            if (!is_short && this.lex.peek().val_('=')) {
                this.lex.expect_('=')
                has_expr = true
            }
        }

        if (!has_expr && !this.lex.peek().nl_before) {
            this.lex.expect_('=')
        }

        let expr = undefined as undefined | Expr
        if (has_expr) {
            expr = this.pratt.parseExpr(0, { avoidBrace: false })
        }
        return {
            kind: 'Binding', name, bind_expr, is_pub, is_short, is_mut, is_shared, type, expr,
            span: this.gs()
        }
    }

    parseForLoop(): StmtDecl {
        this.saveStart()
        this.lex.expect('for')
        const p1 = this.lex.peek()
        const p2 = this.lex.peek(1)
        const p3 = this.lex.peek(2)
        if ((p1.type_('ID') && (p2.val_('in') || p2.val_(',') && p3.type_('ID'))) ||
            (p1.kwd_('await'))
        ) {
            let is_await = false
            if (p1.kwd_('await')) {
                is_await = true
                this.lex.expect('await')
            }
            const var_name = this.lex.expect('ID').val
            let var_name2 = undefined as undefined | string
            if (this.lex.peek().val_(',')) {
                this.lex.expect_(',')
                var_name2 = this.lex.expect('ID').val
            }
            this.lex.expect('in')
            const expr = this.pratt.parseExpr(0, { avoidBrace: true })
            const block = this.parseBlockDecl()
            return { kind: 'ForLoop', is_await, mode: 'in', var_name, var_name2, expr, block, span: this.gs() }
        } else if (p1.val_('{')) {
            const block = this.parseBlockDecl()
            return { kind: 'ForLoop', mode: 'infinite', block, span: this.gs() }
        } else {
            throw new Error(`Unkown for-loop format: ${this.lex.info()}`)
        }
    }


}
