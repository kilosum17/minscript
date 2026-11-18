import { getLogger } from "../utils/log"

export const LexLog = getLogger('lex')

export const SYMBOLS = [
    '(', ')', '[', ']', '{', '}', '<', '>', '+', '-', '*', '/', '=', '!', '&', '|', '^', '%', '~', '?', ':', '.', ';', ',',
    '->', '=>', '#', '??', '\\'
] as const

export const symoblSet = new Set([...SYMBOLS] as string[])

export const KEYWORDS = [
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return', 'fn', 'var', 'let', 'const', 'as',
    'class', 'extends', 'super', 'this', 'new', 'delete', 'TypeOf', 'is', 'in', 'void', 'yield', 'await', 'package', 'import',
    'pub', 'type', 'async', 'union', 'match', 'select', 'recover', 'panic', 'lock', 'shared',
    // Add more keywords as needed
] as const

export const keywordSet = new Set([...KEYWORDS] as string[])

export const SIGILS = ['r{', 'm{', 's{', 'a[', 't('] as const

const sigilSet = new Set([...SIGILS] as string[])

export const mergeMap = (() => {
    const all = [
        'r{', 's{', 'm{', 't(', 'a[', '#{',
        '->', '=>', ':=', ':==',
        '==', '!=', '<=', '>=',
        '+=', '-=', '/=', '*=',
        '??', '?.', '>>', '<<',
        '...', '..', '..=',
        '&&', '||',
    ]
    const map = {} as Record<string, Set<string>>
    all.forEach(v => {
        const k = v.substring(0, 1)
        if (!map[k]) map[k] = new Set([])
        map[k].add(v.substring(1, 2))
        if (v.length > 2) {
            const k2 = v.substring(0, 2)
            if (!map[k2]) map[k2] = new Set([])
            map[k2].add(v.substring(2, 3))
        }
    })
    // console.log('MAP', map)
    return map
})()

export function isSigil(char: string): boolean {
    return sigilSet.has(char)
}

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

