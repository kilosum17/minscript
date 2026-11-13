import { Lexer } from "./syntax/lexer/lexer"

async function main() {
    const operation = process.argv[2]
    const file = process.argv[3]

    if (operation === 'lex') {
        if (!file) {
            console.error('Please provide a file to lex.')
            process.exit(1)
        }
        const text = await Bun.file(file).text()
        const lexer = new Lexer(text)
        lexer.tokenize()
        console.log('Lexing completed. Tokens: ',lexer.toks.length)
    }
    
}

main()