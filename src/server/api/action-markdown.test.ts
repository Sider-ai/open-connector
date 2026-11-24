import type { ActionDefinition } from "../../core/types.ts";

import { describe, expect, it } from "vitest";
import { jsonSchema } from "../../core/json-schema.ts";
import { renderActionMarkdown } from "./action-markdown.ts";

const action: ActionDefinition = {
  id: "github.delete_repository",
  service: "github",
  name: "delete_repository",
  description: "Delete a repository.",
  operationType: "destructive",
  requiredScopes: [],
  providerPermissions: [],
  inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  outputSchema: { type: "object" },
};

describe("renderActionMarkdown", () => {
  it("describes alternative field groups and includes one complete group in examples", () => {
    const markdown = renderActionMarkdown(
      {
        ...action,
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" }, content: { type: "string" }, contentBase64: { type: "string" } },
          required: ["id"],
          anyOf: [{ required: ["content"] }, { required: ["contentBase64"] }],
        },
      },
      { transport: { kind: "http", origin: "http://localhost:8787" } },
    );
    expect(markdown).toContain("Provide every field in at least one of these input groups:");
    expect(markdown).toMatch(/`content`\s*\| Conditional/u);
    expect(markdown).toMatch(/`contentBase64`\s*\| Conditional/u);
    const example = JSON.parse(markdown.match(/-d '([^'\n]+)'/u)![1]!).input;
    expect(example).toEqual({ id: "<id>", content: "<content>" });
  });

  it("does not reduce constrained anyOf branches to a field-presence rule", () => {
    const markdown = renderActionMarkdown(
      {
        ...action,
        inputSchema: {
          type: "object",
          properties: { content: { type: "string" } },
          anyOf: [{ required: ["content"], properties: { content: { const: "fixed" } } }],
        },
      },
      { transport: { kind: "http", origin: "http://localhost:8787" } },
    );
    expect(markdown).not.toContain("at least one of these input groups");
  });

  it("includes declared follow-up actions in the model-facing guide", () => {
    const markdown = renderActionMarkdown(
      { ...action, followUpActions: ["github.update_file"] },
      { transport: { kind: "http", origin: "http://localhost:8787" } },
    );
    expect(markdown).toContain("## Follow-up Actions");
    expect(markdown).toContain("github.update_file");
    expect(
      renderActionMarkdown(action, { transport: { kind: "http", origin: "http://localhost:8787" } }),
    ).not.toContain("## Follow-up Actions");
  });

  it("renders HTTP request examples against the caller's public origin", () => {
    const markdown = renderActionMarkdown(action, {
      transport: { kind: "http", origin: "https://connector.example.com" },
    });

    expect(markdown).toContain("## Execute");
    expect(markdown).toContain(
      "curl -s https://connector.example.com/v1/actions/github.delete_repository \\\n" +
        "  -H 'content-type: application/json' \\\n" +
        `  -d '{"input":{"repo":""}}'`,
    );
    expect(markdown).toContain('fetch("https://connector.example.com/v1/actions/github.delete_repository"');
    expect(markdown).toContain("Use the runtime endpoint above");
    expect(markdown).not.toContain("localhost");
    expect(markdown).not.toContain("execute_action");
  });

  it("keeps the curl example valid when an example value contains an apostrophe", () => {
    const markdown = renderActionMarkdown(
      {
        ...action,
        inputSchema: {
          type: "object",
          properties: { owner: { type: "string", default: "O'Reilly" } },
          required: ["owner"],
        },
      },
      { transport: { kind: "http", origin: "https://connector.example.com" } },
    );

    expect(markdown).toContain(`  -d '{"input":{"owner":"O'\\''Reilly"}}'`);
  });

  it("renders an execute_action example for MCP callers instead of HTTP requests", () => {
    const markdown = renderActionMarkdown(
      {
        ...action,
        inputSchema: {
          type: "object",
          properties: { repo: { type: "string", pattern: "^prj_", minLength: 5 } },
          required: ["repo"],
        },
      },
      { transport: { kind: "mcp" } },
    );

    expect(markdown).toContain("Call the `execute_action` tool with these arguments:");
    expect(markdown).toContain(
      "```json\n" +
        JSON.stringify({ actionId: "github.delete_repository", input: { repo: "prj_a" } }, null, 2) +
        "\n```",
    );
    expect(markdown).toContain("Add `connectionName` to run the action with a named connection");
    expect(markdown).toContain("Use the `execute_action` tool above");
    expect(markdown).not.toContain("curl");
    expect(markdown).not.toContain("fetch(");
    expect(markdown).not.toContain("localhost");
  });

  it("renders the current execution policy decision and decisive rule", () => {
    const markdown = renderActionMarkdown(action, {
      transport: { kind: "mcp" },
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

  it("renders the description of a nullable property", () => {
    const markdown = renderActionMarkdown(
      {
        ...action,
        inputSchema: {
          type: "object",
          properties: { name: jsonSchema.nullableString("The nullable display name.") },
          required: ["name"],
        },
      },
      { transport: { kind: "mcp" } },
    );

    expect(markdown).toContain("The nullable display name.");
  });
});
