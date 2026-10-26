
// use when instead of match and allow complex matches maybe exhastive
// what if we want to ignore the argument to a closure eg
s := "Am Ted"
s2 := s.if_empty(#{"Ted Shem"})

sum := (a:i32, b:i32) -> i32 {
    return a + b
}

fun adder(a:i32,b:i32, sum: (i32,i32)->i32){
    return sum(a, b)
}

n := adder(10, 12, (a, b) => {
    return a + b
})

// or 
n := adder(10,12, #{it1 + it2}) // # makes parsing easier reduces overload on {}, it1 == it
n := adder(10,12, #{
    let a = it1 // it1 == it
    let b = it2
    a + b // last exp auto returned if function returns
})

let description = when payment {
    PaymentMethod.CreditCard { number, exp } => "Card: ${number}",
    PaymentMethod.MobileMoney { phone, provider } => "${provider} account",
    PaymentMethod.Cash => "Cash payment",
    // Compiler error if any variant of PaymentMethod is unhandled
}

// add .is_ok(), .is_err() .is_ok(), is_none() etc to Result/Option
