import { Lexer } from "../lexer/lexer"
import { Parser } from "../parser/parser"
import { Checker } from "../sem/check"
import { Resolver } from "../sem/resolver/resolver"
import { SemAnalysis } from "../sem/type/SemAnalysis"
import { printDiag } from "../utils/diag_utils"

async function main() {
    const operation = process.argv[2]
    const path = process.argv[3]
    let runLexer = false
    let runParser = false
    let runResolve = false
    let runSemantic = false

    if (operation === 'lex') {
        runLexer = true
    } else if (operation === 'parse') {
        runParser = true
    } else if (operation === 'sem') {
        runSemantic = true
    } else if (operation === 'res') {
        runResolve = true
    }

    if (!path) {
        console.error('Please provide a file to lex.')
        process.exit(1)
    }

    if (runLexer || runParser || runResolve) {
        const text = await Bun.file(path).text()
        const lexer = new Lexer(text)
        const parser = new Parser(lexer)
        const resolver = new SemAnalysis()

        if (runLexer) {
            lexer.tokenize()
            console.log('Lexing completed. Tokens: ', lexer.toks.length)

        }
        if (runParser || runResolve) {
            lexer.tokenize()
            parser.parse()
            const diags = parser.diags.map(d => printDiag(d)).join('\n')
            console.log(diags)
        }
        if (runResolve) {
            resolver.analyze(parser.nodes)

        }
    } else if (runSemantic) {
        const checker = new Checker(path)
        const diags = await checker.runCheck()
        console.log(diags)
    }
}

main()