import { describe, expect, it } from "vitest";
import { compactEntity, compactList, htmlToText } from "../src/format.js";

describe("htmlToText", () => {
  it("strips tags and decodes entities", () => {
    expect(htmlToText("<p>Hello <b>world</b> &amp; friends</p>")).toBe("Hello world & friends");
  });
  it("keeps line structure", () => {
    expect(htmlToText("<p>One</p><p>Two</p><ul><li>a</li><li>b</li></ul>")).toBe("One\nTwo\n- a\n- b");
    expect(htmlToText("line1<br/>line2")).toBe("line1\nline2");
  });
  it("leaves plain text alone", () => {
    expect(htmlToText("just text")).toBe("just text");
  });
  it("drops scripts and styles", () => {
    expect(htmlToText("<style>p{}</style><p>x</p><script>1</script>")).toBe("x");
  });
});

describe("compactEntity", () => {
  const defect = {
    type: "work_item",
    subtype: "defect",
    id: "1001",
    workspace_id: 1002,
    name: "Crash",
    description: "<p>Steps &lt;here&gt;</p>",
    phase: { type: "phase", id: "1", name: "New", logical_name: "phase.defect.new", workspace_id: 1002 },
    owner: { type: "workspace_user", id: "7", name: "jane", full_name: "Jane Doe", email: "jane@x.com" },
    sprint: null,
    product_areas: { total_count: 1, data: [{ type: "product_area", id: "9", name: "Checkout" }] },
    story_points: 3,
  };

  it("compacts references, drops noise and converts memos", () => {
    expect(compactEntity(defect)).toEqual({
      id: "1001",
      type: "defect",
      name: "Crash",
      description: "Steps <here>",
      phase: { id: "1", name: "New", logical_name: "phase.defect.new" },
      owner: { id: "7", name: "jane", email: "jane@x.com" },
      product_areas: [{ id: "9", name: "Checkout", type: "product_area" }],
      story_points: 3,
    });
  });

  it("keeps html when asked", () => {
    expect((compactEntity(defect, { html: "html" }) as { description: string }).description).toBe("<p>Steps &lt;here&gt;</p>");
  });

  it("returns raw when asked", () => {
    expect(compactEntity(defect, { raw: true })).toBe(defect);
  });

  it("compacts lists with counts", () => {
    const out = compactList({ total_count: 120, data: [defect], exceeds_total_count: true }) as Record<string, unknown>;
    expect(out.total_count).toBe(120);
    expect(out.returned).toBe(1);
    expect(out.exceeds_total_count).toBe(true);
  });
});
