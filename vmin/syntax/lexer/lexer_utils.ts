
const SYMBOLS = [
    '(', ')', '[', ']', '{', '}', '<', '>', '+', '-', '*', '/', '=', '!', '&', '|', '^', '%', '~', '?', ':', '.', ';', ','
] as const

const symoblSet = new Set([...SYMBOLS] as string[])
const KEYWORDS = [
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return', 'fn', 'var', 'let', 'const',
    'class', 'extends', 'super', 'this', 'new', 'delete', 'TypeOf', 'is', 'in', 'void', 'yield', 'await', 'package', 'import', 'pub'
    // Add more keywords as needed
] as const

const keywordSet = new Set([...KEYWORDS] as string[])

export function isSymbol(char: string): boolean {
    return symoblSet.has(char)
}

export function isKeyword(word: string): boolean {
    return keywordSet.has(word)
}

export function isWhitespace(char: string): boolean {
    return char === ' ' || char === '\t' || char === '\n' || char === '\r'
}
export function isIdentStart(char: string): boolean {
    return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_'
}

export function isIdentPart(char: string): boolean {
    return isIdentStart(char) || (char >= '0' && char <= '9')
}

export function isDigit(char: string): boolean {
    return char >= '0' && char <= '9'
}

export function isHexDigit(char: string): boolean {
    return (char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')
}

export function isOctalDigit(char: string): boolean {
    return char >= '0' && char <= '7'
}

export function isBinaryDigit(char: string): boolean {
    return char === '0' || char === '1'
}

export function isNewline(char: string): boolean {
    return char === '\n' || char === '\r'
}

export function isStringDelimiter(char: string): boolean {
    return char === '"' || char === "'"
}

export function isCommentStart(char: string): boolean {
    return char === '/' || char === '#'
}

