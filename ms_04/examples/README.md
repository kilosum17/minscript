# v0.4 examples

The realistic part of the v0.2 corpus (`minscript/test/{programs,run,packages,projects,prelude,testing}`),
ported to the v0.4 syntax of `../docs/spec_04_ai.md`, with the original golden outputs (`*.out`,
`config.json`, `report.out`). They become the first end-to-end corpus for the new compiler.

Porting them turned up 14 gaps in the spec. They are now settled in the spec, and the examples cite the
section that covers each case; `../docs/porting_notes.md` records what was decided and why.
