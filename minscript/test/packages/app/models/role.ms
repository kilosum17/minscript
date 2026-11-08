package models

pub union Role = {
    Admin
    Operator
    Guest
}

fun label(r: &Role) -> string {
    match r {
        Admin => "admin"
        Operator => "operator"
        Guest => "guest"
    }
}
