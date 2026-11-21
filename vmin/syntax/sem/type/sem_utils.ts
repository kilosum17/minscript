
let cur_id = 1
export function getId() {
    return cur_id++
}

export function TODO(...msg: any[]): never {
    const info = msg.map(m => {
        if (typeof m === 'object') return JSON.stringify(m)
        return String(m)
    }).join(' ')
    throw new Error(`TODO:` + info)
}

