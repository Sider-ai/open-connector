import { describe, expect, it } from "vitest";
import { safeProviderFailureDiagnostic, safeRunLogError } from "../../server/actions/run-log-summary.ts";
import { toProviderExecutionError } from "../provider-runtime.ts";
import { notionActionHandlers } from "./executors.ts";

describe("Notion upstream diagnostics", () => {
  it("keeps the HTTP status when the upstream error fields have unexpected types", async () => {
    const failure = await notionActionHandlers
      .update_page(
        { pageId: "page-1" },
        {
          accessToken: "mock-token",
          fetcher: async () => Response.json({ code: {}, message: { secret: "private-value" } }, { status: 400 }),
        },
      )
      .catch((error: unknown) => error);
    expect(safeProviderFailureDiagnostic(toProviderExecutionError(failure, "fallback").error)).toEqual({
      providerHttpStatus: 400,
      providerErrorMessage: "notion request failed with 400",
    });
  });
  it("preserves a validation error through the action result and audit summary", async () => {
    const failure = await notionActionHandlers
      .update_page(
        { pageId: "page-1", in_trash: true },
        {
          accessToken: "mock-token",
          fetcher: async () =>
            Response.json(
              {
                code: "validation_error",
                message: "Cannot edit an archived parent. Authorization: Bearer secret-value",
                raw: "private-body",
              },
              { status: 400 },
            ),
        },
      )
      .catch((error: unknown) => error);
    const result = toProviderExecutionError(failure, "fallback");
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(safeProviderFailureDiagnostic(result.error)).toEqual({
      providerHttpStatus: 400,
      providerErrorMessage: "Cannot edit an archived parent. authorization=[redacted]",
      providerErrorCode: "validation_error",
    });
    expect(safeRunLogError(result.error).errorMessage).toBe(
      "validation_error: Cannot edit an archived parent. authorization=[redacted]",
    );
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("private-body");
  });

  it.each([401, 403, 404, 409, 429, 500])("preserves upstream HTTP %i", async (status) => {
    const failure = await notionActionHandlers
      .update_page(
        { pageId: "page-1", in_trash: true },
        {
          accessToken: "mock-token",
          fetcher: async () => Response.json({ code: "object_not_found", message: "Page unavailable" }, { status }),
        },
      )
      .catch((error: unknown) => error);
    expect(safeProviderFailureDiagnostic(toProviderExecutionError(failure, "fallback").error)?.providerHttpStatus).toBe(
      status,
    );
  });
});
