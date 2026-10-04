<p align="center"><img src="images/icon.png" width="128" alt="OSC Lens logo"></p>

# OSC Lens

Editor support for **OMSI 2** `.osc` scripts, their varlists and constfiles. The checks are not
guesses about the language: they follow what `Omsi.exe`'s script compiler does, taken from
reverse engineering notes in [`docs/script-compiler.md`](docs/script-compiler.md).

## What you get

- **Highlighting** for scripts, varlists and constfiles. Varlists and constfiles are recognised by
  being listed in your `.bus`/`.ovh`/`.sco`, whatever they are called.
- **Diagnostics** (below), each tagged with how well it is established.
- **Hover that uses your vehicle**: where a variable is declared, how many places read and write it
  (with the lines), a macro's comment, body and callers, the `.wav` a sound trigger plays, a curve's
  range, a constant's value, and the line behind a register load (`l2` shows the `s2` that set it).
- **Go to definition** and **find references** for variables, constants, curves, macros and
  sound triggers; **outline** and **folding** for macros, triggers and `{if}` blocks.
- **Completion** for operators, `(X.Y.name)` accesses, directives, project variables, constants,
  curves, macros, callbacks and sound triggers (`[trigger]` entries from your sound cfg). In varlists
  and constfiles it also suggests names your scripts use that nothing declares yet, and offers
  `[const]` / `[newcurve]` / `[pnt]` snippets.

## Install

Download `osc-lens-<version>.vsix` from the
[Releases](https://github.com/ZackaryH8/osc-lens/releases) page, then:

```
code --install-extension osc-lens-<version>.vsix
```

Open a vehicle folder that contains the `.bus` (or the scenery `.sco`) and its scripts.

## Settings

| Setting | Purpose |
| --- | --- |
| `oscLens.omsiPath` | Your OMSI 2 folder. Lets the extension read `program/varlist_roadvehicle.txt` so undeclared-variable checks are exact, and jump to built-in variables. Without it those checks stay off for vehicles. |
| `oscLens.stackAnalysis` | Experimental stack-depth checks right after an entry header. |
| `oscLens.disabledRules` | Diagnostic codes to hide, for example `stray-endif`. |

Content paths are resolved case-insensitively, so Windows-style content works on Linux.

## What it checks

| Code | Meaning | Evidence |
| --- | --- | --- |
| `unknown-word` | A word OMSI cannot compile: unknown operator, unknown `{directive}`, glued tokens such as `{if}(L.L.x)`, a `'` that is not in column 0, wrong-case operators (`Min`), registers other than `s0`-`s9`/`l0`-`l9` | ida |
| `unmatched-if-else` / `stray-endif` | `{if}`/`{else}` without an `{endif}` (undefined behaviour in OMSI) / an extra `{endif}` (tolerated) | ida |
| `macro-order` | A macro is called before it is defined in the text. OMSI only resolves calls to macros defined later | ida |
| `undeclared-variable`, `unknown-constant`, `unknown-curve` | Name not found in the vehicle's varlists / constfiles | ida |
| `dollar-noop`, `lowercase-access` | Words OMSI silently compiles to nothing | ida |
| `trigger-case`, `unknown-sound-trigger` | `(T.L.x)` does not match a `[trigger]` exactly, including case | ida / hyp |
| `dup-last-wins`, `dup-entry-first-wins` | Duplicate macros, triggers or entries | ida / hyp |
| varlist / constfile rules | Duplicates (first wins), padded or unusable names, `[pnt]` before `[newcurve]`, bad values | ida / corpus |

**Evidence tags.** `ida` was read from the executable and documented; `corpus` comes from the OMX
engine and stock scripts; `hyp` is unverified. A `hyp` finding is never an error.

## Limits, stated plainly

- **Nothing here has been checked inside OMSI itself.** The rules come from a decompile and are
  unit-tested; they have not been compared against how OMSI behaves in a running game.
- Whether `{if}` pops its condition is **unresolved**. The stack analysis is therefore opt-in and
  deliberately narrow.
- The operator list is verified by count, not by spelling: seven operators that the OMX engine
  accepts (`ln cos tan arccos frac round sign`) are flagged as probable non-operators.
- The `(M.V.)` engine callback list is incomplete, so unknown callbacks are warnings.
- Trigger duplicate resolution is inferred from compile order, not from OMSI's runtime lookup.
- Model, sound and AI config files are not checked; only scripts, varlists and constfiles.

## Development

```
npm install
npm test          # data check, compile, unit tests
npm run package   # bundle, smoke-test the bundled server, build the .vsix
```

Press F5 in VS Code from the repository root to launch an Extension Development Host. The language data
that drives everything lives in [`data/osc-language.json`](data/osc-language.json); every entry
carries its evidence tag and a source.

## Licence

[MIT](LICENSE). Not affiliated with Aerosoft or the OMSI developers.
