import { describe, expect, it } from "vitest";
import { createResultFieldSelection } from "./core/result-fields.ts";
import { completeOutputExamples, describeOutputSchema, describeOutputValue } from "./mcp-output-fields.ts";

describe("MCP output field overview", () => {
  it("describes nested output schemas, local references and nullable fields", () => {
    const overview = describeOutputSchema({
      type: "object",
      properties: {
        items: { type: "array", items: { $ref: "#/$defs/item" } },
        cursor: { type: ["string", "null"] },
      },
      $defs: { item: { type: "object", properties: { id: { type: "integer", description: "Record ID." } } } },
    });
    expect(overview.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "items[].id", type: "integer", description: "Record ID." }),
        expect.objectContaining({ path: "cursor", type: "string | null" }),
      ]),
    );
    expect(overview.hasMore).toBe(false);
  });

  it("bounds large schemas and lets a caller explore a field prefix", () => {
    const schema = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 150 }, (_, i) => [
          `field${i}`,
          { type: "object", properties: { value: { type: "string" } } },
        ]),
      ),
    };
    expect(describeOutputSchema(schema)).toMatchObject({ fields: expect.any(Array), hasMore: true });
    expect(describeOutputSchema(schema).fields).toHaveLength(100);
    expect(describeOutputSchema(schema, "field149").fields).toEqual([
      { path: "field149", type: "object", dynamic: true },
      { path: "field149.value", type: "string" },
    ]);
    expect(describeOutputSchema(schema, "field1").fields).toEqual([
      { path: "field1", type: "object", dynamic: true },
      { path: "field1.value", type: "string" },
    ]);
    expect(describeOutputSchema(schema, "$").fields).toHaveLength(100);
  });

  it("discovers heterogeneous output paths and generates usable quoted selectors", () => {
    const output = { "a.b": [{ id: 1 }, { name: "two" }] };
    const overview = describeOutputValue(output);
    expect(overview.fields).toEqual(
      expect.arrayContaining([
        { path: '["a.b"]', type: "array", count: 2 },
        { path: '["a.b"][].name', type: "string" },
      ]),
    );
    expect(createResultFieldSelection(['["a.b"][].name']).project(output)).toEqual({ "a.b": [{}, { name: "two" }] });
  });

  it("returns only complete bounded examples and terminates for recursive schemas", () => {
    const value = { items: [{ id: 1 }, { body: "x".repeat(100_000) }] };
    const examples = completeOutputExamples(value);
    expect(examples).toContainEqual({ path: "items[]", value: { id: 1 } });
    expect(JSON.stringify(examples).length).toBeLessThan(2_000);
    expect(JSON.stringify(examples)).not.toContain("truncated");
    expect(describeOutputSchema({ $defs: { loop: { $ref: "#/$defs/loop" } }, $ref: "#/$defs/loop" })).toEqual({
      fields: [],
      hasMore: true,
    });
  });
});
