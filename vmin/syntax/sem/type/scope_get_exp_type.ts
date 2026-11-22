import type { Expr } from "../../parser/ast_types";
import { checkOpers } from "../resolver/oper_utils";
import { getBlockType } from "./block_utils";
import { getIterItemType } from "./generic_utils";
import { getScopeName, getScopeTypeDecl } from "./scope_get_type_of";
import { areTypesSame } from "./scope_types_same";
import { getMemberType, getReturnType, printBindingType } from "./scope_utils";
import { TODO } from "./sem_utils";
import type { SemScope } from "./SemScope";
import type { BindingType } from "./symbol";

export function getExpType(scope: SemScope, e: Expr): BindingType | undefined {
    if (e.kind === 'Call') {
        const lhsType = getExpType(scope, e.lhs)
        // console.log('CallLhsp', lhsType, getReturnType(lhsType))
        return getReturnType(lhsType)
    }
    // if(e.)
    if (e.kind == 'Literal') {
        if (e.mode == 'BOOL') {
            return { ast_type: { mode: 'var', type_name: 'bool' } }
        }
        if (e.mode == 'CHAR') {
            return { ast_type: { mode: 'var', type_name: 'char' } }
        }
        if (e.mode == 'BYTE') {
            return { ast_type: { mode: 'var', type_name: 'byte' } }
        }
        if (e.mode == 'NUM') {
            if (e.val.includes('.')) {
                return { ast_type: { mode: 'var', type_name: 'f64' } }
            } else {
                return { ast_type: { mode: 'var', type_name: 'int' } }
            }
        }
    }
    if (e.kind === 'Var') {
        return getScopeName(scope, e.name)
    }
    if (e.kind == 'Binary') {
        const lhs = getExpType(scope, e.lhs)
        const rhs = getExpType(scope, e.rhs)
        const lhsStr = printBindingType(scope, lhs) || ''
        const rhsStr = printBindingType(scope, rhs) || ''

        if (e.oper == '..' || e.oper === '..=') {
            return {
                type_hints: [lhsStr, rhsStr],
                ast_type: { mode: 'var', type_name: 'Range' }
            }
        }

        const resType = checkOpers(e.oper, lhsStr, rhsStr)
        // console.log('lhs', lhs, lhsStr, rhsStr)
        if (resType) {
            return { ast_type: { mode: 'var', type_name: resType } }
        }

    }

    if (e.kind == 'String') {
        return { ast_type: { mode: 'var', type_name: 'str', } }
    }
    if (e.kind === 'StructInit') {
        const lhs = getExpType(scope, e.lhs)
        return { ...lhs, ast_type: null }
    }
    if (e.kind === 'Member') {
        const lhs = getExpType(scope, e.lhs)
        if (!lhs) TODO("Member lhs type unkown", lhs)
        const decl = getScopeTypeDecl(scope, lhs.type_id!)
        if (!decl) TODO('Unkown type ', lhs)
        if (e.rhs.kind != 'Var') TODO('RHs in memebr not var', e.rhs)
        const memType = getMemberType(decl, e.rhs.name)
        // console.log('type', memType)
        return memType
    }
    if (e.kind === 'MapInit') {
        let prevKeyType = undefined as BindingType | undefined
        let prevValType = undefined as BindingType | undefined
        e.fields.forEach((d) => {
            if (d.mode === 'field') {
                const k = getExpType(scope, d.key)
                const v = getExpType(scope, d.val)
                if (k) {
                    if (prevKeyType && !areTypesSame(prevKeyType, k)) {
                        TODO('Map has difrent key types', k, printBindingType(scope, prevKeyType))
                    }
                    prevKeyType = k
                }
                if (v) {
                    if (prevValType && !areTypesSame(prevValType, v)) {
                        TODO('Map has difrent value types', v, printBindingType(scope, prevValType))
                    }
                    prevValType = v
                }
            }
        })
        if (!prevKeyType && !prevValType) {
            TODO("Couldn't infer key or value types", prevKeyType, prevValType)
        }
        return {
            type_hints: [printBindingType(scope, prevKeyType)!, printBindingType(scope, prevValType)!],
            ast_type: { mode: 'var', type_name: 'Map', }
        }
    }
    if (e.kind === 'SetInit') {
        let prevValType = undefined as BindingType | undefined
        e.items.forEach(item => {
            const valType = getExpType(scope, item)
            if (valType) {
                if (prevValType && !areTypesSame(prevValType, valType)) {
                    TODO("Set item has difrent item kinds", prevValType, valType)
                }
                prevValType = valType
            }
        })
        // console.log("Set type", prevValType)
        return {
            type_hints: [printBindingType(scope, prevValType)!],
            ast_type: { mode: 'var', type_name: 'Set', }
        }
    }
    if (e.kind === 'VecInit') {
        let prevValType = undefined as BindingType | undefined
        e.items.forEach(item => {
            const valType = getExpType(scope, item)
            if (valType) {
                if (prevValType && !areTypesSame(prevValType, valType)) {
                    TODO("Set item has difrent item kinds", prevValType, valType)
                }
                prevValType = valType
            }
        })
        // console.log("Vec type", prevValType)
        return {
            type_hints: [printBindingType(scope, prevValType)!],
            ast_type: { mode: 'var', type_name: 'Vec', }
        }
    }
    if (e.kind == 'Recover') {
        const resType = getBlockType(scope, e.block)
        return {
            type_hints: [printBindingType(scope, resType)!, 'PanicResult'],
            ast_type: { mode: 'var', type_name: 'Result' }
        }
    }
    if (e.kind === 'Index') {
        const lhsType = getExpType(scope, e.lhs)
        if (!lhsType) TODO('Unkown lhs in index', lhsType)
        return getIterItemType(scope, lhsType!)
    }
    console.log("other", e)
}