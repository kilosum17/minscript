package models

pub type User = {
    pub id: int
    pub name: string
    pub role: Role = Guest

    pub fun new(id: int, name: string, role: Role) -> User {
        User { id, name: tidy(name), role }
    }

    pub fun is_admin(&this) -> bool { this.role == Admin }
}

/// One line about a user (uses `label`, from the other file of this package).
pub fun describe(u: &User) -> string {
    "#${u.id} ${u.name} (${label(u.role)})"
}

// private to the package: other packages can't call it
fun tidy(name: string) -> string { name.trim() }
