package opts

// Field defaults are lowered where the struct literal is, in the importing package: they need this
// package's checker decisions (variants, calls) there.

pub union Level { Low  High(int) }

pub type Opts {
    pub root: str? = None
    pub limit: int? = Some(3)
    pub level: Level = High(2)
    pub tags: Vec[str] = ["a"].map(#{ x => x.to_upper() })
    pub extra: Map[str, str] = m{}
}
