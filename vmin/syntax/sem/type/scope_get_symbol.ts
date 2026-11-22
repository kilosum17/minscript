import { getScopeName } from "./scope_get_type_of";
import { printBindingType } from "./scope_utils";
import type { SemScope } from "./SemScope";

export function getScopeAt(scope: SemScope, offset: number) {
    console.log(`Checking scope ${scope.tag} ${scope.id} = ${scope.bindings.length} at ${scope.span.start}:${scope.span.end}`)
    console.log(`Items: ${scope.bindings.map(b => b.var_name).join(',')}`)
    let foundScope = undefined as undefined | SemScope
    let atPos = scope.span.start <= offset && scope.span.end >= offset
    if (atPos) foundScope = scope

    for (const child of scope.children) {
        let found = getScopeAt(child, offset)
        if (found) {
            foundScope = found
            break
        }
    }

    return foundScope
}

export function getScopeSymbolAt(scope: SemScope, name: string, offset: number) {
    console.log(`###>> starting scan at ${scope.tag}`)

    const foundScope = getScopeAt(scope, offset)
    console.log('Found scope is: ', foundScope?.id)
    if (foundScope) {
        console.log('Offset ', offset, ` scope ${foundScope.span.start}:${foundScope.span.end}`)
        console.log('Syms', foundScope.bindings.map(b => b.var_name).join(','))
        const type = getScopeName(foundScope, name)
        const info = printBindingType(foundScope, type)
        console.log('Info ', type, info)
        return { scope: foundScope, type, info }
    }
    return undefined
}
