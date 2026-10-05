/**
 * Translate the query dialect an LLM naturally writes into the OQL that
 * ALM Octane actually accepts.
 *
 * Accepted input (all equivalent forms are normalised):
 *   phase = 'New' and owner = 'Jane'          ->  phase EQ {name EQ ^New^};owner EQ {name EQ ^Jane^}
 *   severity != 'High'                        ->  !severity EQ {name EQ ^High^}
 *   story_points >= 5                         ->  story_points GE 5
 *   name ~ 'login'                            ->  name EQ ^*login*^
 *   id in (1, 2, 3)                           ->  id IN 1,2,3
 *   creation_time between '2026-01-01' and '2026-02-01'
 *                                             ->  creation_time BTW ^2026-01-01T00:00:00Z^...^2026-02-01T00:00:00Z^
 *   owner = @me                               ->  owner EQ {id EQ <current user id>}
 *   sprint = null                             ->  sprint EQ {null}
 *   parent = {id = 1001}                      ->  parent EQ {id EQ 1001}
 *
 * The output is returned WITHOUT the outer double quotes; add them with quoteQuery().
 */

export interface TranslateOptions {
  /** Workspace user id substituted for @me / me / [current_user]. */
  currentUserId?: string;
  /** Fields known to be references on the entity being queried. Plain values
   *  compared against these are wrapped: 'x' -> {name EQ ^x^}, 12 -> {id EQ 12}. */
  referenceFields?: Iterable<string>;
}

export class OqlError extends Error {}

/** Reference fields that are the same across every Octane instance. Used when
 *  metadata is not available. */
export const DEFAULT_REFERENCE_FIELDS = new Set([
  "owner", "author", "detected_by", "phase", "severity", "priority", "sprint", "release",
  "parent", "team", "milestone", "test", "run", "native_status", "product_areas",
  "application_modules", "detected_in_release", "fixed_in_release", "story", "feature",
  "epic", "test_suite", "covered_content", "covered_requirement", "list_root", "entity_type",
  "owner_work_item", "owner_test", "owner_run", "owner_requirement", "user_tags", "taxonomies",
  "run_by", "last_runs", "root", "workspace_user", "subtype_ref",
]);

type Tok =
  | { t: "str"; v: string }
  | { t: "word"; v: string }
  | { t: "num"; v: string }
  | { t: "op"; v: string }
  | { t: "punct"; v: "{" | "}" | "(" | ")" | "," | ";" | "||" | "!" | "..." };

const WORD_OPS = new Set(["EQ", "NE", "LT", "GT", "LE", "GE", "IN", "BTW", "BETWEEN", "LIKE", "CONTAINS"]);
const SYMBOL_OPS = ["!=", "<>", ">=", "<=", "==", "=", ">", "<", "~"];

function tokenize(input: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const s = input;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }

    // Quoted strings: '...', "...", ^...^ (with backslash escapes)
    if (c === "'" || c === '"' || c === "^") {
      const quote = c;
      let j = i + 1;
      let v = "";
      while (j < s.length && s[j] !== quote) {
        if (s[j] === "\\" && j + 1 < s.length) { v += s[j + 1]; j += 2; continue; }
        v += s[j]; j++;
      }
      if (j >= s.length) throw new OqlError(`Unterminated string starting at position ${i}: ${s.slice(i, i + 20)}`);
      out.push({ t: "str", v });
      i = j + 1;
      continue;
    }

    if (s.startsWith("...", i)) { out.push({ t: "punct", v: "..." }); i += 3; continue; }
    if (s.startsWith("||", i)) { out.push({ t: "punct", v: "||" }); i += 2; continue; }
    if (s.startsWith("&&", i)) { out.push({ t: "punct", v: ";" }); i += 2; continue; }

    const sym = SYMBOL_OPS.find((op) => s.startsWith(op, i));
    if (sym) { out.push({ t: "op", v: sym }); i += sym.length; continue; }

    if ("{}(),;!".includes(c)) { out.push({ t: "punct", v: c as Tok extends { t: "punct"; v: infer V } ? V : never }); i++; continue; }

    // [current_user] placeholder
    if (c === "[") {
      const end = s.indexOf("]", i);
      if (end < 0) throw new OqlError(`Unterminated [ at position ${i}`);
      out.push({ t: "word", v: s.slice(i, end + 1) });
      i = end + 1;
      continue;
    }

    // Bare ISO dates: 2026-09-01 or 2026-09-01T10:00:00Z
    const date = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?(?![\w-])/.exec(s.slice(i));
    if (date) { out.push({ t: "word", v: date[0] }); i += date[0].length; continue; }

    // Numbers (allow negative and decimals)
    const num = /^-?\d+(\.\d+)?(?![\w-])/.exec(s.slice(i));
    if (num) { out.push({ t: "num", v: num[0] }); i += num[0].length; continue; }

    // Words: identifiers, keywords, bare dates, @me
    const word = /^[@A-Za-z_][\w.:@-]*/.exec(s.slice(i));
    if (word) {
      const w = word[0];
      const upper = w.toUpperCase();
      if (upper === "AND") out.push({ t: "punct", v: ";" });
      else if (upper === "OR") out.push({ t: "punct", v: "||" });
      else if (upper === "NOT") out.push({ t: "punct", v: "!" });
      else if (WORD_OPS.has(upper)) out.push({ t: "op", v: upper });
      else out.push({ t: "word", v: w });
      i += w.length;
      continue;
    }
    throw new OqlError(`Unexpected character '${c}' at position ${i} in query`);
  }
  return out;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

function caret(v: string): string {
  return "^" + v.replace(/\\/g, "\\\\").replace(/\^/g, "\\^") + "^";
}

function stringValue(v: string): string {
  if (DATE_ONLY.test(v)) return caret(`${v}T00:00:00Z`);
  if (DATE_TIME.test(v) && !/(Z|[+-]\d{2}:\d{2})$/.test(v)) return caret(`${v}Z`);
  return caret(v);
}

class Parser {
  private pos = 0;
  private readonly refs: Set<string>;
  constructor(private readonly toks: Tok[], private readonly opts: TranslateOptions) {
    this.refs = new Set(opts.referenceFields ?? DEFAULT_REFERENCE_FIELDS);
  }

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok {
    const t = this.toks[this.pos++];
    if (!t) throw new OqlError("Unexpected end of query");
    return t;
  }
  private isPunct(v: string): boolean { const t = this.peek(); return !!t && t.t === "punct" && t.v === v; }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.t !== "punct" || t.v !== v) throw new OqlError(`Expected '${v}' but found '${t.v}'`);
  }

  parseAll(): string {
    const out = this.parseExpr();
    if (this.pos < this.toks.length) throw new OqlError(`Unexpected '${this.toks[this.pos].v}' after end of query`);
    return out;
  }

  /** expr := term ((';' | '||') term)* */
  private parseExpr(): string {
    let out = this.parseTerm();
    while (this.isPunct(";") || this.isPunct("||")) {
      const sep = (this.next() as { v: string }).v;
      out += sep + this.parseTerm();
    }
    return out;
  }

  /** term := '!'? ( '(' expr ')' | predicate ) */
  private parseTerm(): string {
    let negate = false;
    if (this.isPunct("!")) { this.next(); negate = true; }
    if (this.isPunct("(")) {
      this.next();
      const inner = this.parseExpr();
      this.expectPunct(")");
      return (negate ? "!" : "") + "(" + inner + ")";
    }
    return this.parsePredicate(negate);
  }

  /** predicate := field op value */
  private parsePredicate(negate: boolean): string {
    const fieldTok = this.next();
    if (fieldTok.t !== "word") throw new OqlError(`Expected a field name but found '${fieldTok.v}'`);
    const field = fieldTok.v;
    if (this.isPunct("!")) { this.next(); negate = !negate; } // field NOT IN (...)
    const opTok = this.next();
    if (opTok.t !== "op") throw new OqlError(`Expected a comparison operator after '${field}' but found '${opTok.v}'`);
    const isRef = this.refs.has(field);

    let op = opTok.v;
    if (op === "!=" || op === "<>" || op === "NE") { negate = !negate; op = "EQ"; }
    const neg = negate ? "!" : "";

    switch (op) {
      case "=": case "==": case "EQ":
        return `${neg}${field} EQ ${this.parseValue(field, isRef)}`;
      case ">": case "GT": return `${neg}${field} GT ${this.parseScalar(field)}`;
      case "<": case "LT": return `${neg}${field} LT ${this.parseScalar(field)}`;
      case ">=": case "GE": return `${neg}${field} GE ${this.parseScalar(field)}`;
      case "<=": case "LE": return `${neg}${field} LE ${this.parseScalar(field)}`;
      case "~": case "LIKE": case "CONTAINS": {
        const t = this.next();
        if (t.t !== "str" && t.t !== "word") throw new OqlError(`'${field} ~' needs a string value`);
        const v = t.v.includes("*") ? t.v : `*${t.v}*`;
        return isRef ? `${neg}${field} EQ {name EQ ${caret(v)}}` : `${neg}${field} EQ ${caret(v)}`;
      }
      case "IN": return this.parseIn(field, isRef, neg);
      case "BTW": case "BETWEEN": {
        const a = this.parseScalar(field);
        if (this.isPunct("...")) this.next();
        else if (this.isPunct(";")) this.next(); // 'between a and b' -> AND was tokenised to ';'
        else throw new OqlError(`'${field} BETWEEN' needs two values joined by 'and' or '...'`);
        const b = this.parseScalar(field);
        return `${neg}${field} BTW ${a}...${b}`;
      }
      default:
        throw new OqlError(`Unsupported operator '${op}'`);
    }
  }

  private parseIn(field: string, isRef: boolean, neg: string): string {
    const paren = this.isPunct("(");
    if (paren) this.next();
    const values: string[] = [];
    const refValues: string[] = [];
    do {
      if (this.isPunct("{")) { refValues.push(this.parseBraces()); continue; }
      const t = this.next();
      if (t.t === "str") { if (isRef) refValues.push(`{name EQ ${caret(t.v)}}`); else values.push(stringValue(t.v)); }
      else if (t.t === "num") { if (isRef) refValues.push(`{id EQ ${t.v}}`); else values.push(t.v); }
      else if (t.t === "word") { values.push(this.wordValue(t.v, field, isRef)); }
      else throw new OqlError(`Unexpected '${t.v}' in IN list`);
    } while (this.isPunct(",") && this.next());
    if (paren) this.expectPunct(")");

    if (refValues.length) {
      const all = [...refValues, ...values];
      // Octane's IN is documented for scalars; for reference fields the reliable
      // form is an OR of equalities.
      const ors = all.map((v) => `${field} EQ ${v}`).join("||");
      return `${neg}(${ors})`;
    }
    return `${neg}${field} IN ${values.join(",")}`;
  }

  /** value := '{' ... '}' | string | number | word */
  private parseValue(field: string, isRef: boolean): string {
    if (this.isPunct("{")) return this.parseBraces();
    const t = this.next();
    if (t.t === "str") return isRef ? `{name EQ ${caret(t.v)}}` : stringValue(t.v);
    if (t.t === "num") return isRef ? `{id EQ ${t.v}}` : t.v;
    if (t.t === "word") return this.wordValue(t.v, field, isRef);
    throw new OqlError(`Unexpected '${t.v}' where a value was expected for '${field}'`);
  }

  /** A value that must be a scalar (numbers, dates, strings) for ordering operators. */
  private parseScalar(field: string): string {
    const t = this.next();
    if (t.t === "str" && (DATE_ONLY.test(t.v) || DATE_TIME.test(t.v))) return stringValue(t.v);
    if (t.t === "num") return t.v;
    if (t.t === "word" && (DATE_ONLY.test(t.v) || DATE_TIME.test(t.v))) return stringValue(t.v);
    throw new OqlError(`'${field}' needs a number or date value, found '${t.v}'`);
  }

  private wordValue(w: string, field: string, isRef: boolean): string {
    const lower = w.toLowerCase();
    if (lower === "null" || lower === "{null}" || lower === "none" || lower === "empty") return "{null}";
    if (lower === "true" || lower === "false") return lower;
    if (lower === "@me" || lower === "me" || lower === "[current_user]" || lower === "current_user") {
      if (!this.opts.currentUserId) {
        throw new OqlError("'@me' used but the current user could not be resolved. Set OCTANE_CURRENT_USER to your email or name.");
      }
      return field === "id" ? this.opts.currentUserId : `{id EQ ${this.opts.currentUserId}}`;
    }
    if (DATE_ONLY.test(w) || DATE_TIME.test(w)) return stringValue(w);
    // Bare identifier such as a logical name: phase=phase.defect.new
    if (isRef) {
      if (/^\d+$/.test(w)) return `{id EQ ${w}}`;
      if (w.includes(".")) return `{logical_name EQ ${caret(w)}}`;
      return `{name EQ ${caret(w)}}`;
    }
    return caret(w);
  }

  /** '{' (null | expr) '}' with recursive translation of the inner query. */
  private parseBraces(): string {
    this.expectPunct("{");
    if (this.peek()?.t === "word" && this.peek()!.v.toLowerCase() === "null") {
      this.next();
      this.expectPunct("}");
      return "{null}";
    }
    const inner = new Parser(this.sliceBraces(), { ...this.opts, referenceFields: DEFAULT_REFERENCE_FIELDS }).parseAll();
    return `{${inner}}`;
  }

  /** Consume tokens up to the matching '}' and return them (without the brace). */
  private sliceBraces(): Tok[] {
    const inner: Tok[] = [];
    let depth = 1;
    while (true) {
      const t = this.next();
      if (t.t === "punct" && t.v === "{") depth++;
      if (t.t === "punct" && t.v === "}") { depth--; if (depth === 0) break; }
      inner.push(t);
    }
    return inner;
  }
}

/** Translate a friendly query into Octane OQL. Returns "" for empty input. */
export function translateQuery(input: string | undefined | null, opts: TranslateOptions = {}): string {
  if (!input || !input.trim()) return "";
  let q = input.trim();
  // Strip outer double quotes a caller may have added already.
  if (q.length >= 2 && q.startsWith('"') && q.endsWith('"') && !q.slice(1, -1).includes('"')) q = q.slice(1, -1);
  return new Parser(tokenize(q), opts).parseAll();
}

/** Wrap a translated query for the `query` URL parameter. */
export function quoteQuery(translated: string): string {
  return `"${translated}"`;
}
