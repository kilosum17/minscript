import type { Lexer } from "../lexer/lexer";
import type { Token } from "../lexer/lexer_types";
import { isIdent } from "../utils/char_helpers";
import type { AstError, AstNode, BlockDecl, FuncParam, FuncParamsList, FuncType } from "./parser_types";

export class Parser {
    nodes: AstNode[] = []
    curPos = 0
    trackingPub = false
    trackingAsync = false
    skips = 0

    constructor(private lexer: Lexer) {
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
                }
                console.log(node)
            } else {
                // console.log('Unkown', pk1.lexeme)
            }
            if (i++ > 10) {
                break
            }
        }
    }

    getNext(): Token {
        const tok = this.lexer.tokens[this.curPos]
        this.curPos++
        return tok
    }

    peek(n = 0): Token {
        return this.lexer.tokens[this.curPos + n]
    }

    skip(n = 1) {
        this.curPos += n
    }

    expect(expected: string, tok: Token): AstError {
        return { kind: 'Error', message: `Expected '${expected}' got '${tok.lexeme}'` }
    }

    parsePackageDecl(): AstNode {
        this.getNext()
        const n1 = this.getNext()
        return { kind: 'PackageDecl', name: n1.lexeme }
    }

    parseImportDecl(): AstNode {
        this.getNext()
        const n1 = this.getNext()
        if (n1.lexeme !== '"') {
            return {
                kind: "Error", recoverBefore: [],
                message: `import paths must be quoted eg 'import "std.log"' got ${n1.lexeme} `
            }
        }
        const parts = []
        let cur = this.getNext()
        while (isIdent(cur.lexeme) || cur.lexeme == ".") {
            parts.push(cur.lexeme)
            cur = this.getNext()
        }
        if (cur.lexeme != '"') {
            return this.expect(`["]`, n1)
        }
        return {
            kind: 'ImportDecl', path: parts.join('')
        }
    }

    parseFuncDecl(): AstNode {
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
        if (!isIdent(n2.lexeme)) {
            return this.expect('identifier', n2)
        }
        const name = n2.lexeme
        const n3 = this.getNext()
        if (n3.lexeme !== '(') {
            return this.expect('(', n3)
        }
        const params = this.parseParamsList()
        const n4 = this.getNext()
        if (n4.lexeme != ')') {
            return this.expect(')', n4)
        }

        const p1 = this.peek()
        let return_: FuncType | AstError
        if (p1.lexeme == '->') {
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
        let cur = this.peek()
        let params: (FuncParam | AstError)[] = [
            this.parseParam()
        ]
        while (cur.lexeme == ',') {
            params.push(this.parseParam())
        }
        return {
            kind: 'ParamsList', params,
        }
    }

    parseParam(): (FuncParam | AstError) {
        const n1 = this.getNext()
        if (!isIdent(n1.lexeme)) {
            return this.expect(`identifier`, n1)
        }
        const n2 = this.getNext()
        if (n2.lexeme != ':') {
            return this.expect(`:`, n2)
        }
        const type = this.parseType()
        return { kind: 'Param', type }
    }

    parseType(): (FuncType | AstError) {
        const n1 = this.getNext()
        if (!isIdent(n1.lexeme)) {
            return this.expect('identifier', n1)
        }
        const name = n1.lexeme
        return { kind: 'Type', name, generics: [] }
    }

    parserBlock(): BlockDecl | AstError {
        const n1 = this.getNext()
        if (n1.lexeme != '{') {
            return this.expect('{', n1)
        }
        let cur
        do {
            cur = this.getNext()
        } while (cur.lexeme != '}')

        return { kind: 'BlockDecl', statements: [] }
    }

    parserStatement() {
        const path = this.peekPath()
        if (path) {
            this.skip(path.len)

        }
    }

    peekPath() {
        let idx = 0
        const n1 = this.peek(idx)
        if (!isIdent(n1.lexeme)) return false
        let parts = [n1.lexeme]
        let prevIsDot = false
        while (isIdent(this.peek(idx).lexeme) || this.peek(idx).lexeme == '.') {
            const part = this.peek(idx).lexeme
            const isDot = part === '.'
            if (prevIsDot && isDot) return false
            if (isDot) prevIsDot = true
            parts.push(part)
        }
        return { path: parts.join(''), len: parts.length }
    }

    tryParseComment(): boolean {
        const p1 = this.peek(0)
        if (p1.lexeme != '//') {
            return false
        }
        this.getNext()
        while (!this.peek().nl_before) {
            this.getNext()
        }
        return true
    }

}
