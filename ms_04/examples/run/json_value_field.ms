package main

import "std.json"

// A field typed with another package's type (`json.Value`) keeps its shape, so `json.parse` builds
// real `json.Value`s for it.
type Outcome {
    config: json.Value? = None
    plain: json.Value = json.Value.Null
    list: Vec[json.Value] = []
}

fn main() {
    let o = json.parse.[Outcome]("{\"config\":{\"a\":1},\"plain\":{\"b\":2},\"list\":[true,\"x\"]}") or e => {
        log.println("error: ${e}")
        return
    }
    var all = [o.config ?? json.Value.Null, o.plain] as Vec[json.Value]
    all.extend(o.list)
    for v in all.iter() {
        let kind = match v {
            Object(_) => "object"
            Bool(_) => "bool"
            Str(_) => "string"
            _ => "other"
        }
        log.println("${kind}: ${json.stringify(v)}")
    }
}
