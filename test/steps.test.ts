import { describe, expect, it } from "vitest";
import { scriptToSteps, stepsToScript } from "../src/tools/tests.js";

describe("manual test script DSL", () => {
  it("renders steps, validations and calls", () => {
    expect(stepsToScript([
      { text: "Open the login page" },
      { text: "Is the logo visible?", type: "validation" },
      { text: "1234", type: "call" },
    ])).toBe("- Open the login page\n- ?Is the logo visible?\n- @1234");
  });

  it("flattens newlines inside a step", () => {
    expect(stepsToScript([{ text: "line one\nline two" }])).toBe("- line one line two");
  });

  it("parses back", () => {
    expect(scriptToSteps("- a\n- ?b\n- @3\n\nignored")).toEqual([
      { type: "step", text: "a" },
      { type: "validation", text: "b" },
      { type: "call", text: "3" },
    ]);
  });
});
