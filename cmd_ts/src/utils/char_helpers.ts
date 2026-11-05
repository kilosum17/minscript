import { operSet } from "../lexer/lexer_types"
import { mergeMap } from "./merge_map"

export const isAlpha = (c: string) => {
    const n = c.charCodeAt(0)
    return (n >= 65 && n <= 90) || (n >= 97 && n <= 122)
}

export const isNumeric = (c: string) => {
    const n = c.charCodeAt(0)
    return n >= 48 && n <= 57
}

export const isAlphaNumeric = (c: string) => {
    return isAlpha(c) || isNumeric(c)
}

export const isSpace = (c: string) => {
    return c === ' ' || c === '\t' || c === '\r'
}
export const isNewLine = (c: string) => {
    return c === '\n'
}

export const isSpaceAndNl = (c: string) => {
    return c === ' ' || c === '\t' || c === '\r' || c === '\n'
}

export const isSpecial = (c: string) => {
    return operSet.has(c) || c == '"' || 
        c == '$' || c == ',' || c == '#' ||
        c == '\\' || c == "'"
}

export const isIdent = (value: string): boolean => {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)
}

export const isNum = (value: string): boolean => {
    return /^-?\d+(\.\d+)?$/.test(value)
}

export const tryMerge = (c: string) => {
    return !!mergeMap[c]
}
export const canMerge = (c1: string, c2: string) => {
    if (!mergeMap[c1]) return false
    if (typeof mergeMap[c1] === 'string') return mergeMap[c1] === c2
    return mergeMap[c1].has(c2)
}

