package models

pub type User {
    pub id: int
    pub name: str
    pub role: Role = Guest

    pub fn new(id: int, name: str, role: Role) -> User {
        User { id, name: tidy(name), role }
    }

    pub fn is_admin(this) -> bool { this.role == Admin }
}

/// One line about a user (uses `label`, from the other file of this package).
pub fn describe(u: User) -> str {
    "#${u.id} ${u.name} (${label(u.role)})"
}

// private to the package: other packages can't call it
fn tidy(name: str) -> str { name.trim() }
