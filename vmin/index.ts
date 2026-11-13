import { Lexer } from "./syntax/lexer/lexer"
import { Parser } from "./syntax/parser/parser"

async function main() {
    const operation = process.argv[2]
    const file = process.argv[3]
    let runLexer = false
    let runParser = false

    if (operation === 'lex') {
        runLexer = true
    } else if (operation === 'parse') {
        runParser = true
    }

    if (!file) {
        console.error('Please provide a file to lex.')
        process.exit(1)
    }

    const text = await Bun.file(file).text()
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



}

main()