import type { ActionDefinition } from "../../core/types.ts";

import { describe, expect, it } from "vitest";
import { renderActionMarkdown } from "./action-markdown.ts";

const action: ActionDefinition = {
  id: "github.delete_repository",
  service: "github",
  name: "delete_repository",
  description: "Delete a repository.",
  requiredScopes: [],
  providerPermissions: [],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
};

describe("renderActionMarkdown", () => {
  it("describes alternative field groups and includes one complete group in examples", () => {
    const markdown = renderActionMarkdown({
      ...action,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, content: { type: "string" }, contentBase64: { type: "string" } },
        required: ["id"],
        anyOf: [{ required: ["content"] }, { required: ["contentBase64"] }],
      },
    });
    expect(markdown).toContain("Provide every field in at least one of these input groups:");
    expect(markdown).toMatch(/`content`\s*\| Conditional/u);
    expect(markdown).toMatch(/`contentBase64`\s*\| Conditional/u);
    const example = JSON.parse(markdown.match(/-d '([^'\n]+)'/u)![1]!).input;
    expect(example).toEqual({ id: "<id>", content: "<content>" });
  });

  it("does not reduce constrained anyOf branches to a field-presence rule", () => {
    const markdown = renderActionMarkdown({
      ...action,
      inputSchema: {
        type: "object",
        properties: { content: { type: "string" } },
        anyOf: [{ required: ["content"], properties: { content: { const: "fixed" } } }],
      },
    });
    expect(markdown).not.toContain("at least one of these input groups");
  });

  it("includes declared follow-up actions in the model-facing guide", () => {
    const markdown = renderActionMarkdown({ ...action, followUpActions: ["github.update_file"] });
    expect(markdown).toContain("## Follow-up Actions");
    expect(markdown).toContain("github.update_file");
    expect(renderActionMarkdown(action)).not.toContain("## Follow-up Actions");
  });

  it("renders the current execution policy decision and decisive rule", () => {
    const markdown = renderActionMarkdown(action, {
      policy: {
        allowed: false,
        code: "action_blocked",
        message: "Action is blocked.",
        checks: [{ source: "runtime", outcome: "block_match", rule: "github.delete_repository" }],
      },
    });

    expect(markdown).toContain("## Execution Policy");
    expect(markdown).toContain("Denied: Action is blocked.");
    expect(markdown).toContain("`runtime`: `block_match` via `github.delete_repository`");
  });
});
