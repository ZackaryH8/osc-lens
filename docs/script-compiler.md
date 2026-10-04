# OMSI 2.3 script compiler (`.osc` → TXPC node graph)

> Copied from the reverse-engineering notes of the OMSI.MP project (`RE/omsi-2.3-script-compiler.md`). References such as
> `RE/omsi-2.3-vehicle-script-ingestion-audit.md` and `RE/omsi-2.3-vehicle-sound-system.md` point at other notes in that project.

Source: Hex-Rays output of `sub_5D1E68` (pasted into a session 2026-10-04; IDA was not reachable, so
nothing here was re-checked in the IDB and the IDB was not annotated). Everything marked **PROVEN** is
read directly from that output. **STRONG** is one inference step. **HYP** is unverified.

Not covered: the *execute* methods of the node classes, so runtime semantics (e.g. whether `{if}` pops
its condition) are still open. The spellings of operator strings are constants the paste does not
show, so token-to-opcode mapping is by count only.

Signature: `sub_5D1E68(files@EAX, high@EDX, ?, ?, out*, consts*, callbacks, varsL, varsStr)`.
`out[0..2]` entry heads, `out[3]/[4]` trigger heads/names, `out[5]` list of every node created.
Related, already documented in `omsi-2.3-vehicle-script-ingestion-audit.md`: file reading, BOM,
column-0 `'` comments, one concatenated stream (SI18–SI21).

## 1. Passes

1. **Read** each script file; skip empty lines and lines whose first character is `'` (39); append every
   other line plus a separator to one string. A missing file is logged ("Error while loading file").
   **PROVEN.** Per-file end offsets are kept (`v287`) only to name the file in error text.
2. **Tokenise** that string: toggle quote state on `"` (34); split on tab (9) or space (32) only while
   outside quotes. **PROVEN.** There is *no* brace or parenthesis awareness. `{if}(L.L.x)` with no space is
   one token.
3. **Compile tokens from the last to the first** (`v32 = High(array)` … `0`). Each new node gets
   `+4 = previous node in the global list` and `+8 = v279`, the node compiled just before it, i.e. the
   *following* token. So the graph is a continuation-linked list built backwards. **PROVEN.**

Consequence of pass 3: everything that looks something up "so far" sees only what is *later* in the text.

## 2. Token classification (order of tests, **PROVEN**)

| Test | Result |
| --- | --- |
| first char `"` **and** last char `"` | string node, text = inner part |
| first char `$` | one of **19** string functions (codes 28–46) by exact, case-sensitive string compare; **no match ⇒ no node, silently** |
| `{if}` | `if` node, pushed on an if-stack; `+8 = +12 = v279` (join point) |
| `{else}` | top if-node `+12 = v279`; `v279 = top.+8` |
| `{if}` (opening) | top if-node `+8 = v279`; `v279 = top`; pop |
| three entry tags | `out[0] = v279`, `out[1] = v279`, `out[2] = v279` (STRONG: init, frame, frame_ai) |
| `{end}` | `v279 = 0` (does **not** touch the if-stack) |
| starts `{macro:` and ends `}` | records `(name, v279)` in the macro list |
| starts `{trigger:` and ends `}` | records `(name, v279)` in the trigger list |
| one token | func 47 (STRONG: `%stackdump%`) |
| length 2 and first char `s` | register store node, index `StrToInt(token[1])` |
| length 2 and first char `l` | register load node, index `StrToInt(token[1])` |
| **28** exact operator spellings | func codes 0–27, each used once |
| starts `(`, ends `)`, `token[2]=='.'`, `token[4]=='.'` | access, see §3 |
| anything else | `StrToFloat(token)` value node; non-numbers raise `EConvertError` |

Notes:
- Comparisons are `UStrEqual` / `LStrEqual`, i.e. **case-sensitive**. `Min`, `$CutEnd`, `{Frame}` and
  lower-case access letters are not recognised.
- Registers are `s0`–`s9` / `l0`–`l9` only. `s15` has length 3, so it falls through to `StrToFloat` and
  fails. `ln` has length 2 and starts with `l`, so it would be taken as a register load and `StrToInt('n')`
  fails; it cannot be an operator.
- **STRONG:** the 28 operator codes match the 28 non-`$` tokens in openOMSI's list of exe operator tokens
  (`+ - * / % = < > ! d /-/ <= >= && || sin arcsin arctan min max exp sqrt sqr sgn pi random abs trunc`).
  `ln cos tan arccos frac round sign` (in OMX's table) would make 35, so they are probably not OMSI operators.
  `$=>` is not one of the 19 `$` functions, so it compiles to nothing. Needs the string constants to close.

## 3. Access tokens `(X.Y.name)` (**PROVEN**)

`X` and `Y` are single, **upper-case** characters; the name is everything after the second dot up to the
final `)`. A `(...)` token whose dots are not at characters 2 and 4 goes to `StrToFloat` and fails. An access
whose `X` is not one of `L S M C T F` creates no node and no error.

| X | Y | Node | Lookup | Not found |
| --- | --- | --- | --- | --- |
| L, S | `L` | numeric variable (`+16=0`) | local numeric table | log `SC_ErrorInCommand … varinvalid`, node kept with index −1 |
| L, S | `$` | string variable (`+16=2`) | string table | same |
| L, S | anything else | system variable (`+16=1`) | system table | same |
| M | `L` | macro call, links straight to the macro's first node | macros registered **so far** | log `…macroinvalid` |
| M | `V` | engine callback, index into callback list | callback list | log `…macroinvalid` (same text) |
| C | any | constant, **value copied into the node at compile time** | constants | log `…constantinvalid` |
| T | `F` or other | sound trigger, name kept as text (`+16 = (Y=='F')`) | none at compile time | never an error |
| F | `L` | curve | curve list | **raises `EXPC`** (`SC_ErrorInCommand_functioninvalid`), aborting the compile |

`+17` of a variable node is `(X == 'S')`, the store flag. Variable, macro, callback and constant errors are
suppressed when global `byte_86121C` is set (HYP: a "silent load" flag); the curve exception is not.

Error text is built as `SC_ErrorInCommand` + ` "<file>" (<token>) ` + the specific string and passed to the
logging call (IDB name `Wbcomp::CalcElementXY`, HYP: a mislabelled library thunk).

## 4. Consequences (what the editor can state as fact)

1. **A macro must be defined after the call.** Macros register while scanning backwards, so a call sees only
   macros later in the *concatenated* text (this file or any later script file). All three scripts checked
   (a gearbox, an engine and a dashboard script) obey this: gearbox before engine, helpers after callers.
   **PROVEN** from the scan order; not live-tested here.
2. **Duplicate names: the textually last definition wins** for macros and for triggers, because the lists are
   built last-to-first and looked up first-match. This matches openOMSI's observation that a later file's
   trigger replaces an earlier one. It **contradicts the OMX comment** "first match wins, a repeated name never
   runs" (`ScriptCompiler.AddTrigger`). STRONG for triggers: the runtime lookup is not in this function, so
   verify it where `out[3]/[4]` are searched.
3. **`{init}` / `{frame}` duplicates: the textually first wins** (later scan overwrites). STRONG.
   `out[2]` falls back to `out[1]` when no third entry exists, so **AI vehicles without `{frame_ai}` run
   `{frame}`**. PROVEN.
4. **Stray `{endif}` is harmless; stray `{if}` / `{else}` is undefined.** `{endif}` only pushes a join node, so
   extra ones just stay on the stack. An unmatched `{if}` or `{else}` indexes element −1 of the if-stack.
   The if-stack is also *not* cleared at `{end}`, so a surplus `{endif}` in a later block can be consumed by an
   unbalanced `{if}` earlier in the file instead of failing. PROVEN.
5. **Unknown words, unknown `{directives}`, glued tokens (`{if}(L.L.x)`), a trailing `'` comment and
   `(M.L.)`-style malformed accesses are all `StrToFloat` failures**, i.e. exceptions, not tolerated.
   Only `$`-prefixed unknowns and wrong-case access letters are silently dropped.
6. **Constants are baked in** at compile time; a missing constant is logged but not fatal.
7. **An unknown curve is fatal to the compile**, unlike openOMSI's note that the O530 Facelift tolerates
   missing converter curves. How the caller reacts to `EXPC` (and whether partial `out[]` heads survive) is
   open; heads for text scanned before the failure were already written.

## 5. Open

- Runtime semantics of the `if` node (VMT `0x5D0D70`): does it pop its condition? Several real scripts chain
  `&& {if} … x &&` as if it peeks. Needs the node's execute method.
- Token spellings behind func codes 0–27, 28–46 and 47: read the string operands of the compare calls.
- Caller of `sub_5D1E68`: handling of `EXPC` / `EConvertError`, and which output slot is init / frame / frame_ai.
- `byte_86121C` meaning; `dword_861220/24/28` hook calls on variable lookup.
