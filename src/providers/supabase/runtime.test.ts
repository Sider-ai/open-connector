import { describe, expect, it } from "vitest";
import { safeProviderFailureDiagnostic, safeRunLogError } from "../../server/actions/run-log-summary.ts";
import { toProviderExecutionError } from "../provider-runtime.ts";
import { supabaseActionHandlers } from "./runtime.ts";

describe("Supabase upstream diagnostics", () => {
  it("preserves a non-JSON HTTP failure without recording the response body", async () => {
    const failure = await supabaseActionHandlers
      .run_read_only_query(
        { projectRef: "exampleproject", query: "select 1" },
        {
          accessToken: "mock-token",
          fetcher: async () => new Response("private proxy error page", { status: 503 }),
        },
      )
      .catch((error: unknown) => error);
    const result = toProviderExecutionError(failure, "fallback");
    expect(safeProviderFailureDiagnostic(result.error)).toEqual({
      providerHttpStatus: 503,
      providerErrorMessage: "supabase returned a non-JSON error response",
    });
    expect(JSON.stringify(result)).not.toContain("private proxy error page");
  });
  it.each([400, 404, 409, 422, 500])(
    "preserves HTTP %i and the upstream code without the response body",
    async (status) => {
      const failure = await supabaseActionHandlers
        .run_read_only_query(
          { projectRef: "exampleproject", query: "select 1" },
          {
            accessToken: "mock-token",
            fetcher: async () =>
              Response.json(
                { code: "42P01", message: "Relation does not exist", query: "private query body" },
                { status },
              ),
          },
        )
        .catch((error: unknown) => error);
      const result = toProviderExecutionError(failure, "fallback");
      expect(safeProviderFailureDiagnostic(result.error)).toEqual({
        providerHttpStatus: status,
        providerErrorMessage: "Relation does not exist",
        providerErrorCode: "42P01",
      });
      expect(safeRunLogError(result.error).errorMessage).toBe("42P01: Relation does not exist");
      expect(JSON.stringify(result)).not.toContain("private query body");
    },
  );
});
