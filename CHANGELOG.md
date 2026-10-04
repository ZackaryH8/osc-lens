# Changelog

## 0.1.0

First release.

- Syntax highlighting for `.osc` scripts, plus highlighting for varlists and constfiles.
- Diagnostics that follow how Omsi.exe's script compiler behaves (unknown words, case-sensitive
  operators and access letters, `s0`-`s9`/`l0`-`l9` registers, `{if}`/`{endif}` matching, macro
  call order, undeclared variables/constants/curves, sound-trigger names).
- Project awareness through the `.bus`/`.ovh`/`.sco` that lists a script.
- Completion, project-aware hover, go-to-definition, find references, outline and folding.
- Completion and checks for varlists and constfiles, found through the `.bus` that references them.
- Not yet tested inside OMSI itself; see the README for what is and is not verified.
