import { describe, expect, it } from "vitest";
import { translateQuery, quoteQuery, OqlError } from "../src/oql.js";

const t = (q: string, opts?: Parameters<typeof translateQuery>[1]) => translateQuery(q, opts);

describe("translateQuery", () => {
  it("returns empty for empty input", () => {
    expect(t("")).toBe("");
    expect(t("   ")).toBe("");
  });

  it("translates simple equality on scalar fields", () => {
    expect(t("name = 'Login bug'")).toBe("name EQ ^Login bug^");
    expect(t("story_points = 5")).toBe("story_points EQ 5");
    expect(t("has_attachments = true")).toBe("has_attachments EQ true");
  });

  it("wraps plain values on reference fields", () => {
    expect(t("owner = 'Jane Doe'")).toBe("owner EQ {name EQ ^Jane Doe^}");
    expect(t("parent = 1001")).toBe("parent EQ {id EQ 1001}");
    expect(t("phase = phase.defect.new")).toBe("phase EQ {logical_name EQ ^phase.defect.new^}");
    expect(t("severity = High")).toBe("severity EQ {name EQ ^High^}");
  });

  it("uses live reference metadata when given", () => {
    expect(t("custom_ref = 'X'", { referenceFields: ["custom_ref"] })).toBe("custom_ref EQ {name EQ ^X^}");
    expect(t("owner = 'X'", { referenceFields: ["custom_ref"] })).toBe("owner EQ ^X^");
  });

  it("passes through braces and translates inside them", () => {
    expect(t("parent = {id = 1001}")).toBe("parent EQ {id EQ 1001}");
    expect(t("owner = {email = 'a@b.com'}")).toBe("owner EQ {email EQ ^a@b.com^}");
    expect(t("release = {name ~ '26'}")).toBe("release EQ {name EQ ^*26*^}");
    expect(t("sprint = {null}")).toBe("sprint EQ {null}");
  });

  it("handles null", () => {
    expect(t("sprint = null")).toBe("sprint EQ {null}");
    expect(t("story_points = null")).toBe("story_points EQ {null}");
    expect(t("owner != null")).toBe("!owner EQ {null}");
  });

  it("translates and/or/not and symbols", () => {
    expect(t("phase = 'New' and owner = 'Jane'")).toBe("phase EQ {name EQ ^New^};owner EQ {name EQ ^Jane^}");
    expect(t("phase = 'New' && owner = 'Jane'")).toBe("phase EQ {name EQ ^New^};owner EQ {name EQ ^Jane^}");
    expect(t("phase = 'New' or phase = 'Open'")).toBe("phase EQ {name EQ ^New^}||phase EQ {name EQ ^Open^}");
    expect(t("phase = 'New' ; owner = 'Jane'")).toBe("phase EQ {name EQ ^New^};owner EQ {name EQ ^Jane^}");
    expect(t("not name = 'x'")).toBe("!name EQ ^x^");
    expect(t("!(name = 'x' or name = 'y')")).toBe("!(name EQ ^x^||name EQ ^y^)");
  });

  it("does not rewrite 'and' inside quoted strings", () => {
    expect(t("name = 'login and logout'")).toBe("name EQ ^login and logout^");
  });

  it("translates inequality and comparisons", () => {
    expect(t("severity != 'High'")).toBe("!severity EQ {name EQ ^High^}");
    expect(t("severity <> 'High'")).toBe("!severity EQ {name EQ ^High^}");
    expect(t("story_points >= 5")).toBe("story_points GE 5");
    expect(t("story_points <= 5")).toBe("story_points LE 5");
    expect(t("id > 100")).toBe("id GT 100");
    expect(t("id < 100")).toBe("id LT 100");
    expect(t("id GT 100")).toBe("id GT 100");
  });

  it("translates contains", () => {
    expect(t("name ~ 'login'")).toBe("name EQ ^*login*^");
    expect(t("name ~ 'DSO*'")).toBe("name EQ ^DSO*^");
    expect(t("name like 'login'")).toBe("name EQ ^*login*^");
    expect(t("owner ~ 'jane'")).toBe("owner EQ {name EQ ^*jane*^}");
  });

  it("translates IN lists", () => {
    expect(t("id in (1, 2, 3)")).toBe("id IN 1,2,3");
    expect(t("id IN 1,2,3")).toBe("id IN 1,2,3");
    expect(t("subtype in ('defect','story')")).toBe("subtype IN ^defect^,^story^");
    expect(t("severity in ('High','Urgent')")).toBe("(severity EQ {name EQ ^High^}||severity EQ {name EQ ^Urgent^})");
    expect(t("owner not in (1, 2)")).toBe("!(owner EQ {id EQ 1}||owner EQ {id EQ 2})");
  });

  it("translates between", () => {
    expect(t("id between 10 and 20")).toBe("id BTW 10...20");
    expect(t("id BTW 10...20")).toBe("id BTW 10...20");
    expect(t("creation_time between '2026-01-01' and '2026-02-01'")).toBe("creation_time BTW ^2026-01-01T00:00:00Z^...^2026-02-01T00:00:00Z^");
  });

  it("normalises dates", () => {
    expect(t("creation_time >= '2026-09-01'")).toBe("creation_time GE ^2026-09-01T00:00:00Z^");
    expect(t("creation_time >= 2026-09-01")).toBe("creation_time GE ^2026-09-01T00:00:00Z^");
    expect(t("creation_time > '2026-09-01T10:00:00'")).toBe("creation_time GT ^2026-09-01T10:00:00Z^");
    expect(t("creation_time > '2026-09-01T10:00:00+01:00'")).toBe("creation_time GT ^2026-09-01T10:00:00+01:00^");
  });

  it("resolves @me", () => {
    expect(t("owner = @me", { currentUserId: "42" })).toBe("owner EQ {id EQ 42}");
    expect(t("owner = me", { currentUserId: "42" })).toBe("owner EQ {id EQ 42}");
    expect(t("owner = [current_user]", { currentUserId: "42" })).toBe("owner EQ {id EQ 42}");
    expect(t("id = @me", { currentUserId: "42" })).toBe("id EQ 42");
    expect(() => t("owner = @me")).toThrow(OqlError);
  });

  it("accepts native OQL unchanged in meaning", () => {
    expect(t("phase EQ {name EQ ^New^};owner EQ {id EQ 1002}")).toBe("phase EQ {name EQ ^New^};owner EQ {id EQ 1002}");
    expect(t("name EQ ^*timeout*^")).toBe("name EQ ^*timeout*^");
    expect(t("detected_in_release EQ {null}")).toBe("detected_in_release EQ {null}");
  });

  it("strips outer double quotes added by a caller", () => {
    expect(t("\"name = 'x'\"")).toBe("name EQ ^x^");
  });

  it("escapes carets and backslashes inside strings", () => {
    expect(t("name = 'a^b'")).toBe("name EQ ^a\\^b^");
    expect(t("name = 'it\\'s'")).toBe("name EQ ^it's^");
  });

  it("supports double-quoted values", () => {
    expect(t('name = "Login"')).toBe("name EQ ^Login^");
  });

  it("gives helpful errors", () => {
    expect(() => t("name =")).toThrow(/Unexpected end/);
    expect(() => t("name 'x'")).toThrow(/comparison operator/);
    expect(() => t("name = 'unterminated")).toThrow(/Unterminated/);
    expect(() => t("story_points > 'abc'")).toThrow(/number or date/);
  });

  it("quotes for the URL parameter", () => {
    expect(quoteQuery("a EQ 1")).toBe('"a EQ 1"');
  });
});
