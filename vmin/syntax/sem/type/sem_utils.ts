
let cur_id = 1
export function getId() {
    return cur_id++
}

export function TODO(...msg: any[]): never {
    throw new Error(`TODO:` + msg.map(String).join(' '))
}

