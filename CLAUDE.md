# Working agreements

## Tautological labels, tests, and UI components are considered harmful

- Do not write tests that only assert something you just did (e.g. "X no longer exists" after removing X). Deletion needs no test.
- Do not add labels, comments, or UI text that merely restate what the code or element already says.
- Do not build simulations, harnesses, or fixtures the user didn't ask for as a way to "verify" work. If verification needs one, ask first.
- Scope rule: do what was asked. When a task is done, stop. Extra machinery is cost, not safety.
