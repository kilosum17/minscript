import { Lexer } from "../lexer/lexer"
import { Parser } from "../parser/parser"

async function main() {
    const operation = process.argv[2]
    const path = process.argv[3]
    let runLexer = false
    let runParser = false
    let runSemantic = false

    if (operation === 'lex') {
        runLexer = true
    } else if (operation === 'parse') {
        runParser = true
    } else if (operation === 'sem') {
        runSemantic = true
    }

    if (!path) {
        console.error('Please provide a file to lex.')
        process.exit(1)
    }

    if (runLexer || runParser) {
        const text = await Bun.file(path).text()
        const lexer = new Lexer(text)
        const parser = new Parser(lexer)

        if (runLexer) {
            lexer.tokenize()
            console.log('Lexing completed. Tokens: ', lexer.toks.length)

        }
        if (runParser) {
            lexer.tokenize()
            parser.parse()
        }
    } else if (runSemantic) {

    }
}

main()