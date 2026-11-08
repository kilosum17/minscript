package opts

// Field defaults are lowered where the struct literal is, in the importing package: they need this
// package's checker decisions (variants, calls) there.

pub union Level = { Low  High(int) }

pub type Opts = {
    pub root: string? = None
    pub limit: int? = Some(3)
    pub level: Level = High(2)
    pub tags: Vec[string] = ["a"].map(#{ x => x.to_upper() })
    pub extra: Map[string, string] = m{}
}
