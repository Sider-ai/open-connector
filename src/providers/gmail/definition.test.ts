import { describe, expect, it } from "vitest";
import { optionalRecord } from "../../core/cast.ts";
import { provider } from "./definition.ts";

describe("Gmail email summaries", () => {
  it("defaults fetch_emails to summary and guides callers away from full list hydration", () => {
    const action = provider.actions.find((candidate) => candidate.name === "fetch_emails");
    const detail = optionalRecord(action?.inputSchema.properties)?.detail;

    expect(action?.description).toContain("Prefer summary detail");
    expect(detail).toMatchObject({
      type: "string",
      enum: ["summary", "ids", "full"],
      default: "summary",
      description: expect.stringContaining("should remain summary for list or search requests"),
    });
  });
});
