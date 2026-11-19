import { float_set, int_set, type ResolvedTypeKind } from "./resolver_types";

export function printSaveTypeKind(t: ResolvedTypeKind | undefined) {
    if (!t) return ''
    switch (t.kind) {
        case "Basic": {
            return `${t.decl.type}(${t.decl.val})`
        }
        case "ScopeRef": {
            return `ref(${t.ref.name})`
        }
        default: {
            return `TODO:`
        }
    }
}


export const isBasicType = (type: ResolvedTypeKind | undefined) => {
    if (type?.kind === 'Basic') {
        return type.decl
    }
    return false
}

