import { describe, expect, it } from "vitest";
import { createResultFieldSelection, ResultFieldsError } from "./result-fields.ts";

describe("result field selection", () => {
  it("projects nested arrays and preserves pagination and item positions without mutating output", () => {
    const output = {
      total_count: 3,
      items: [
        { name: "one", owner: { login: "alice", avatar: "large" }, body: "large" },
        { name: "two", owner: null },
        { name: "three" },
      ],
    };
    const snapshot = JSON.stringify(output);
    expect(createResultFieldSelection(["total_count", "items[].name", "items[].owner.login"]).project(output)).toEqual({
      total_count: 3,
      items: [{ name: "one", owner: { login: "alice" } }, { name: "two", owner: null }, { name: "three" }],
    });
    expect(JSON.stringify(output)).toBe(snapshot);
  });

  it("handles empty and nested root arrays and nullable results", () => {
    expect(createResultFieldSelection(["items[].id"]).project({ items: [] })).toEqual({ items: [] });
    expect(createResultFieldSelection(["[][].id"]).project([[{ id: 1, body: "large" }], []])).toEqual([
      [{ id: 1 }],
      [],
    ]);
    expect(createResultFieldSelection(["record.id"]).project({ record: null })).toEqual({ record: null });
    expect(createResultFieldSelection(["$"]).project("text")).toBe("text");
  });

  it("supports literal keys containing dots, brackets, quotes and empty strings", () => {
    const output = { "a.b": [{ "x[y]": { 'a"b': 3 } }], "": 4, $: 5 };
    expect(createResultFieldSelection(['["a.b"][]["x[y]"]["a\\"b"]', '[""]', '["$"]']).project(output)).toEqual(output);
  });

  it("reports unmatched selectors instead of silently returning empty data", () => {
    expect(() => createResultFieldSelection(["items[].typo"]).project({ items: [{ id: 1 }] })).toThrow(/not found/);
    expect(() => createResultFieldSelection(["items.id"]).project({ items: [{ id: 1 }] })).toThrow(/not found/);
  });

  it("does not retain unselected scalar data from heterogeneous arrays", () => {
    expect(createResultFieldSelection(["items[].id"]).project({ items: ["large unselected body", { id: 1 }] })).toEqual(
      {
        items: [null, { id: 1 }],
      },
    );
  });

  it.each([
    "",
    ".items",
    "items.",
    "items..id",
    "items[0]",
    "items[]id",
    "__proto__.x",
    'items["constructor"]',
    "a.".repeat(17) + "b",
  ])("rejects invalid or unsafe selector %s before execution", (path) =>
    expect(() => createResultFieldSelection([path])).toThrow(ResultFieldsError),
  );
});
