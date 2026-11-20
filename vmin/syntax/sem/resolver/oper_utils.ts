
export const OPER_DATA = [
    {
        oper: ["+", '-', '*', '/'],
        types: [
            ['int', 'int', 'int'],
            ['int', 'i64', 'i64'],
            ['i32', 'i64', 'i64'],
            ['int', 'f64', 'f64'],
        ]
    },
    {
        oper: ['<', '>', '<=', '>=', '!=', '=='],
        types: [
            ['int', 'int', 'bool'],
            ['int', 'f64', 'bool'],
            ['str', 'str'],
        ]
    },
    {
        oper: ['&&', '||', '!=', '=='],
        types: [
            ['bool', 'bool', 'bool'],
        ]
    },
    {
        oper: ['!'],
        types: [
            ['bool', '', 'bool']
        ]
    },
    {
        oper: ['+'],
        types: [
            ['str', 'str', 'str']
        ]
    }
] as {
    oper: string[],
    types: [string, string, string, boolean?][]
}[]

export function checkOpers(oper: string, a: string, b: string) {
    console.log(`## Call oper oper:${oper} a:${a} b:${b}`)

    for (const d of OPER_DATA) {
        if (d.oper.includes(oper)) {
            const m = d.types.find(t => {
                if (t[0] == a && t[1] == b) return true
                if (t[0] == b && t[1] == a) return true
                return false
            })
            if (m) return m[2]
        }
    }
    return undefined
}
