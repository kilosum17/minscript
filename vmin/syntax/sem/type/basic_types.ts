
const int_types = [
    'u8', 'u32', 'u64', 'int',
    'i8', 'i32', 'i64',
] as const
export const int_set = new Set<string>(int_types)

const float_types = ['f32', 'f64'] as const
export const float_set = new Set<string>(float_types)

let curBasicId = -100
const basicTypeIds = {} as Record<string, number>

export function isBasicType(name: string) {
    if (int_set.has(name) || float_set.has(name) || name === 'bool') {
        if (!basicTypeIds[name]) {
            basicTypeIds[name] = curBasicId++
        }
        return basicTypeIds[name]
    }
    return 0
}
