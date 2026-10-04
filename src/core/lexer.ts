export interface Token {
  text: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

/**
 * Splits script text the way OMSI does (sub_5D1E68, see RE/omsi-2.3-script-compiler.md):
 * a line is dropped when empty or when its FIRST character is an apostrophe; the rest is one
 * stream in which only space or tab outside double quotes separates tokens. No brace or
 * parenthesis awareness. Quote state carries across lines.
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const lines = text.split(/\r\n|\n|\r/);
  let inQuote = false;
  let current: Token | undefined;

  const flush = () => {
    if (current) tokens.push(current);
    current = undefined;
  };

  for (let line = 0; line < lines.length; line++) {
    const source = lines[line];
    if (source.length === 0 || source[0] === "'") continue;
    for (let col = 0; col < source.length; col++) {
      const ch = source[col];
      if (ch === '"') inQuote = !inQuote;
      if ((ch === ' ' || ch === '\t') && !inQuote) {
        flush();
        continue;
      }
      if (!current) current = { text: '', line, col, endLine: line, endCol: col };
      current.text += ch;
      current.endLine = line;
      current.endCol = col + 1;
    }
    // OMSI appends a separator after every accepted line.
    if (inQuote) {
      if (current) current.text += ' ';
    } else {
      flush();
    }
  }
  flush();
  return tokens;
}

/** Delphi StrToFloat as used for plain words; anything else raises EConvertError in OMSI. */
export function isNumber(text: string): boolean {
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text);
}
