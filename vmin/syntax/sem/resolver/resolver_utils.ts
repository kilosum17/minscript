import { type ResolveType, type SemType } from "./resolver_types";

export function printSaveTypeKind(t: ResolveType | undefined) {
    if (!t) return ''
    switch (t.mode) {
        case "var": {
            return `${t.var_name}`
        }
        default: {
            return `TODO:`
        }
    }
}

export function resTypeName(t: SemType | undefined) {
    if (t?.mode === 'var') {
        const gens = t.gens ? `[${t.gens.join(',')}]` : ''
        return t.type_name + gens
    }
    return ''
}