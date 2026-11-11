import { describe, expect, it } from "vitest";
import { validateActionInput } from "../../core/validation.ts";
import { githubActions } from "../../providers/github/actions.ts";
import { safeProviderFailureDiagnostic, safeRunLogError, summarizeForRunLog } from "./run-log-summary.ts";

describe("summarizeForRunLog", () => {
  it("redacts credentials by path, value pattern, and URL", () => {
    expect(
      summarizeForRunLog({
        cookies: [{ name: "session", value: "cookie-secret" }],
        headers: { authorization: "Basic dXNlcjpwYXNz" },
        accessKey: "access-secret",
        token: "abc.def.ghi",
        temporaryUrl: "https://user:pass@example.com/file?token=secret#fragment",
      }),
    ).toEqual({
      cookies: "[redacted]",
      headers: "[redacted]",
      accessKey: "[redacted]",
      token: "[redacted]",
      temporaryUrl: "[redacted-url]",
    });
  });

  it("redacts HTTP authorization schemes case-insensitively", () => {
    expect(
      summarizeForRunLog({
        lowerBearer: "bearer secret-token",
        mixedBasic: "bAsIc dXNlcjpwYXNz",
      }),
    ).toEqual({
      lowerBearer: "[redacted]",
      mixedBasic: "[redacted]",
    });
  });

  it("keeps only the origin of ordinary URLs", () => {
    expect(summarizeForRunLog({ homepageUrl: "https://user:pass@example.com/public/path?view=full#part" })).toEqual({
      homepageUrl: "https://example.com",
    });
  });

  it("redacts sensitive URL contexts and removes path credentials from generic URLs", () => {
    expect(
      summarizeForRunLog({
        url: "https://hooks.slack.com/services/T000/B000/SECRET",
        webhook: { url: "https://example.com/hooks/SECRET" },
        callbackUrl: "https://example.com/callback/SECRET",
        downloadUrl: "https://example.com/files/SECRET",
      }),
    ).toEqual({
      url: "https://hooks.slack.com",
      webhook: { url: "[redacted-url]" },
      callbackUrl: "[redacted-url]",
      downloadUrl: "[redacted-url]",
    });
  });

  it("does not invoke accessors and survives proxies", () => {
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        throw new Error("secret-in-getter");
      },
    });
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("secret-in-proxy");
        },
      },
    );

    expect(summarizeForRunLog(accessor)).toEqual({ value: "[unavailable]" });
    expect(summarizeForRunLog(proxy)).toBe("[unavailable]");
  });

  it("bounds wide summaries", () => {
    const summary = summarizeForRunLog(
      Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`field${index}`, "x".repeat(1_000)])),
    );

    expect(new TextEncoder().encode(JSON.stringify(summary)).byteLength).toBeLessThanOrEqual(16 * 1024);
  });

  it("does not enumerate large typed arrays", () => {
    expect(summarizeForRunLog(new Uint8Array(1_000_000))).toBe("[unavailable]");
  });

  it("keeps summarizing the rest of the value when a URL-like string cannot be parsed", () => {
    expect(
      summarizeForRunLog({
        url: "https://",
        items: ["https://ok.example/x", "http://exa mple.com/y"],
      }),
    ).toEqual({
      url: "https://",
      items: ["https://ok.example", "http://exa mple.com/y"],
    });
  });

  it("redacts unparseable URL-like strings in sensitive contexts", () => {
    expect(
      summarizeForRunLog({
        webhook: { url: "https://hooks.slack.com/services/T000/B000/ SECRET" },
        downloadUrl: "https://",
      }),
    ).toEqual({
      webhook: { url: "[redacted-url]" },
      downloadUrl: "[redacted-url]",
    });
  });

  it("redacts credentials from unparseable URL-like strings", () => {
    expect(summarizeForRunLog({ url: "https://user:super-secret@exa mple.com/path" })).toEqual({
      url: "[redacted-url]",
    });
  });

  it("truncates long unparseable URL-like strings", () => {
    const long = `https://exa mple.com/${"a".repeat(300)}`;
    expect(summarizeForRunLog({ url: long })).toEqual({ url: `${long.slice(0, 256)}[truncated]` });
  });

  it("only scans the retained prefix of long unparseable URL-like strings", () => {
    const long = `https://exa mple.com/?safe=${"a".repeat(300)}&token=SECRET`;
    expect(summarizeForRunLog({ url: long })).toEqual({ url: `${long.slice(0, 256)}[truncated]` });
  });

  it("redacts unparseable URL-like strings with sensitive raw query keys", () => {
    expect(
      summarizeForRunLog({
        url: "https://exa mple.com/?token=abc",
        items: ["https://?api_key=SECRET", "https://exa mple.com/?safe=1"],
      }),
    ).toEqual({
      url: "[redacted-url]",
      items: ["[redacted-url]", "https://exa mple.com/?safe=1"],
    });
  });

  it("redacts partially encoded sensitive query keys in unparseable URLs", () => {
    expect(summarizeForRunLog({ url: "https://exa mple.com/?%74oken%ZZ=SECRET" })).toEqual({
      url: "[redacted-url]",
    });
  });

  it("keeps only the host of protocol-relative URLs", () => {
    expect(summarizeForRunLog({ url: "//user:pass@example.com/path" })).toEqual({ url: "//example.com" });
    expect(summarizeForRunLog({ url: "//user@example.com/path" })).toEqual({ url: "//example.com" });
    expect(summarizeForRunLog({ url: "//cdn.example.com/logo.png" })).toEqual({ url: "//cdn.example.com" });
    expect(summarizeForRunLog({ url: "//example.com:80/path" })).toEqual({ url: "//example.com:80" });
    expect(summarizeForRunLog({ url: "//hooks.slack.com/services/T000/B000/SECRET" })).toEqual({
      url: "//hooks.slack.com",
    });
  });

  it("redacts sensitive protocol-relative URLs", () => {
    expect(summarizeForRunLog({ url: "//example.com/file?token=SECRET" })).toEqual({ url: "[redacted-url]" });
    expect(summarizeForRunLog({ downloadUrl: "//example.com/file" })).toEqual({ downloadUrl: "[redacted-url]" });
  });

  it("redacts userinfo in malformed protocol-relative URLs", () => {
    expect(summarizeForRunLog({ url: "//user@example .com/path" })).toEqual({ url: "[redacted-url]" });
  });

  it("keeps only the origin of non-http URLs", () => {
    expect(summarizeForRunLog({ url: "ftp://user:pass@example.com/file" })).toEqual({ url: "ftp://example.com" });
    expect(summarizeForRunLog({ url: "wss://example.com/socket" })).toEqual({ url: "wss://example.com" });
  });

  it("redacts sensitive query keys in non-http URLs", () => {
    expect(summarizeForRunLog({ url: "s3://bucket/key?token=SECRET" })).toEqual({ url: "[redacted-url]" });
  });
});

describe("safeRunLogError", () => {
  it("retains schema field hints without rejected values or unknown field names", () => {
    const action = githubActions.find((action) => action.name === "list_workflow_run_jobs")!;
    const validation = validateActionInput(action, {
      owner: "example",
      repo: "project",
      runId: "private-value",
      "private-unknown-field": "private-secret",
    });
    const summary = safeRunLogError(
      { code: "invalid_input", message: "Invalid input", details: validation.errors },
      action,
    );
    expect(summary.errorMessage).toContain("runId (type)");
    expect(summary.errorMessage).toContain("unexpected input field");
    expect(JSON.stringify(summary)).not.toContain("private-");
  });

  it("describes alternative required fields without implying both are required", () => {
    const action = githubActions.find((action) => action.name === "create_or_update_file")!;
    const validation = validateActionInput(action, {
      owner: "example",
      repo: "project",
      path: "file",
      message: "Update",
    });
    const summary = safeRunLogError(
      { code: "invalid_input", message: "Invalid input", details: validation.errors },
      action,
    );
    expect(summary.errorMessage).toBe("Invalid action input: provide a valid content or contentBase64.");
  });

  it("does not retain provider error messages", () => {
    expect(
      safeRunLogError({ code: "provider_error", message: "provider returned secret-token", details: { raw: true } }),
    ).toEqual({ errorCode: "provider_error", errorMessage: "The provider request failed." });
  });
});

describe("safeProviderFailureDiagnostic", () => {
  it("uses the original upstream status instead of the normalized execution status", () => {
    const error = {
      code: "invalid_input",
      message: "Validation failed",
      details: {
        status: 400,
        details: { upstreamStatus: 422, upstreamMessage: "Missing file sha", upstreamCode: "missing_field" },
      },
    };
    expect(safeProviderFailureDiagnostic(error)).toEqual({
      providerHttpStatus: 422,
      providerErrorMessage: "Missing file sha",
      providerErrorCode: "missing_field",
    });
    expect(safeRunLogError(error)).toEqual({
      errorCode: "invalid_input",
      errorMessage: "missing_field: Missing file sha",
    });
  });

  it("does not fall back to a normalized status when explicit upstream metadata is invalid", () => {
    expect(
      safeProviderFailureDiagnostic({
        code: "provider_error",
        message: "Failure",
        details: { status: 500, details: { upstreamStatus: 200, upstreamMessage: "Not a failure" } },
      }),
    ).toBeUndefined();
  });
  it("keeps the upstream status and reason while redacting credentials", () => {
    expect(
      safeProviderFailureDiagnostic({
        code: "authorization_failed",
        message: "Trello denied this request.",
        details: {
          status: 403,
          details: { upstreamMessage: "unauthorized org access\nAuthorization: Bearer sensitive-value" },
        },
      }),
    ).toEqual({
      providerHttpStatus: 403,
      providerErrorMessage: "unauthorized org access authorization=[redacted]",
    });
  });

  it("does not log unmarked provider response details", () => {
    expect(
      safeProviderFailureDiagnostic({
        code: "provider_error",
        message: "secret response",
        details: { status: 500, details: { raw: "secret response" } },
      }),
    ).toBeUndefined();
  });
});
