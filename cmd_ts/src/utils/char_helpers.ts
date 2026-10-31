
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

const specialSet = new Set([
    '"', ".",
    "'", ':',
    '*', '+', '-', '/', '%',
    '-', '>', '<', ',',
    '(', ')', '{', '}', '[', ']',
    '$', '&', '#', '?',
    '=', '!', ''
])

export const isSpecial = (c: string) => {
    return specialSet.has(c)
}

