package models

pub union Role {
    Admin
    Operator
    Guest
}

fn label(r: Role) -> str {
    match r {
        Admin => "admin"
        Operator => "operator"
        Guest => "guest"
    }
}
