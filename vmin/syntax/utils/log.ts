import pc from "picocolors";

const logKinds = ['lex', 'parser'] as const
const cleanLogs = true
export type LogKind = typeof logKinds[number]

export class Log {

    constructor(
        private tag: LogKind
    ) {
    }

    getPrefix(color: any, text: string) {
        return ''
    }

    info(...msg: any[]) {
        this.info_(msg, '\n')
    }
    info_(...msg: any[]) {
        process.stdout.write(`${this.getPrefix(pc.yellow, 'INFO:')} ${msg}`)
    }

    warn(...msg: any[]) {
        this.warn(msg, '\n')
    }
    warn_(...msg: any[]) {
        process.stdout.write(`${this.getPrefix(pc.bgCyan, 'WARN:')} ${msg}`)
    }

    error(...msg: any[]) {
        this.error_(msg, '\n')
    }
    error_(...msg: any[]) {
        process.stdout.write(`${this.getPrefix(pc.red, 'Err :')} ${msg}`)
    }

}


export const getLogger = (tag: LogKind): Log => {
    return new Log(tag)
}
