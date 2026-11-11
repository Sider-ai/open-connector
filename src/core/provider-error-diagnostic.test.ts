import { describe, expect, it } from "vitest";
import {
  createProviderErrorDetails,
  createProviderFailureDiagnostic,
  sanitizeProviderDiagnosticMessage,
} from "./provider-error-diagnostic.ts";

describe("provider error diagnostics", () => {
  it("preserves a bounded reason and code without credentials or response bodies", () => {
    const details = createProviderErrorDetails(
      400,
      'validation failed; "access_token": "secret with spaces"; password=hidden; see https://user:pass@example.com/path?token=secret',
      "validation_error",
    );
    expect(details.upstreamCode).toBe("validation_error");
    expect(details.upstreamStatus).toBe(400);
    expect(details.upstreamMessage).toContain("validation failed");
    for (const secret of ["secret with spaces", "hidden", "user:pass", "?token=secret"]) {
      expect(details.upstreamMessage).not.toContain(secret);
    }
    expect(sanitizeProviderDiagnosticMessage("Bearer bearer-secret")).not.toContain("bearer-secret");
    expect(sanitizeProviderDiagnosticMessage("token ghp_examplecredentialvalue12345")).not.toContain("ghp_");
    expect(createProviderErrorDetails(500, "failure ".repeat(1000)).upstreamMessage.length).toBeLessThanOrEqual(512);
  });

  it.each(["invalid code with values", "Bearer secret", "ghp_secret", "x".repeat(100)])(
    "omits unsafe error codes: %s",
    (code) => {
      expect(createProviderFailureDiagnostic(422, "Invalid request", code)).toEqual({
        providerHttpStatus: 422,
        providerErrorMessage: "Invalid request",
      });
    },
  );

  it.each([200, 399, 600, 422.5, NaN])("rejects an invalid failure status: %s", (status) => {
    expect(createProviderFailureDiagnostic(status, "Failure")).toBeUndefined();
  });
});
