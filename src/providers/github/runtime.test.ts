import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../../core/execution.ts";
import { validateActionInput } from "../../core/validation.ts";
import { safeProviderFailureDiagnostic, safeRunLogError } from "../../server/actions/run-log-summary.ts";
import { toProviderExecutionError } from "../provider-runtime.ts";
import { githubActions } from "./actions.ts";
import { pullRequestActionHandlers } from "./runtime-pull-request.ts";
import { repositoryActionHandlers } from "./runtime-repository.ts";
import { normalizeGitHubError } from "./runtime-shared.ts";

const jobsAction = githubActions.find((action) => action.name === "list_workflow_run_jobs")!;
const writeAction = githubActions.find((action) => action.name === "create_or_update_file")!;
const repo = { owner: "example", repo: "project" };
const file = { ...repo, path: "file.txt", message: "Update file" };

describe("GitHub workflow run input", () => {
  it.each([{ runId: 123 }, { run_id: 123 }, { runId: 123, run_id: 123 }])(
    "accepts a run ID and uses the same endpoint: %j",
    async (fields) => {
      const input = { ...repo, ...fields };
      expect(validateActionInput(jobsAction, input).valid).toBe(true);
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        expect(String(url)).toBe("https://api.github.com/repos/example/project/actions/runs/123/jobs");
        return Response.json({ total_count: 1, jobs: [{ id: 7 }] });
      });
      await expect(
        pullRequestActionHandlers.list_workflow_run_jobs!(input, { accessToken: "mock-token", fetcher }),
      ).resolves.toEqual({ total_count: 1, jobs: [{ id: 7 }] });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {},
    { runId: 0 },
    { run_id: -1 },
    { runId: 1.5 },
    { runId: "123" },
    { run_id: null },
    { runId: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid IDs before executing: %j", async (fields) => {
    const executor = vi.fn(async () => ({ ok: true, output: {} }));
    const result = await executeAction(
      jobsAction,
      executor,
      { ...repo, ...fields },
      { getCredential: async () => undefined },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(executor).not.toHaveBeenCalled();
  });

  it("rejects conflicting aliases before issuing a provider request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      pullRequestActionHandlers.list_workflow_run_jobs!(
        { ...repo, runId: 123, run_id: 456 },
        { accessToken: "mock-token", fetcher },
      ),
    ).rejects.toThrow("runId and run_id must match");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("GitHub file write input", () => {
  it.each([{}, { content: null }, { contentBase64: 123 }, { content: "text", sha: " " }])(
    "rejects invalid writes at the schema boundary: %j",
    async (fields) => {
      const executor = vi.fn(async () => ({ ok: true, output: {} }));
      const result = await executeAction(
        writeAction,
        executor,
        { ...file, ...fields },
        { getCredential: async () => undefined },
      );
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(executor).not.toHaveBeenCalled();
    },
  );

  it("also rejects missing contents when a handler is called directly", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => repositoryActionHandlers.create_or_update_file!(file, { accessToken: "mock-token", fetcher })).toThrow(
      "Provide content or contentBase64",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { input: { content: "hello" }, encoded: "aGVsbG8=" },
    { input: { content: "" }, encoded: "" },
    { input: { contentBase64: "" }, encoded: "" },
    { input: { contentBase64: "aGVs\nbG8=" }, encoded: "aGVsbG8=" },
    { input: { content: "hello", contentBase64: "" }, encoded: "aGVsbG8=" },
    { input: { content: "ignored", contentBase64: "aGVsbG8=" }, encoded: "aGVsbG8=" },
  ])("preserves explicit file contents and update preconditions: %j", async ({ input, encoded }) => {
    const value = { ...file, ...input, sha: "current-blob-sha", branch: "main" };
    expect(validateActionInput(writeAction, value).valid).toBe(true);
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({
        message: "Update file",
        content: encoded,
        sha: "current-blob-sha",
        branch: "main",
      });
      return Response.json({ commit: { sha: "new-commit" } });
    });
    await repositoryActionHandlers.create_or_update_file!(value, { accessToken: "mock-token", fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub upstream diagnostics", () => {
  it.each([
    [404, "invalid_input"],
    [422, "invalid_input"],
    [409, "provider_error"],
    [401, "authorization_failed"],
    [403, "authorization_failed"],
    [429, "rate_limited"],
    [503, "provider_error"],
  ])("preserves HTTP %i without changing the execution error category", (status, code) => {
    const failure = normalizeGitHubError(
      new Response(null, { status }),
      { message: "Resource unavailable", code: "example_error", raw: "private-body" },
      "fallback",
    );
    const result = toProviderExecutionError(failure, "fallback");
    expect(result.error?.code).toBe(code);
    expect(safeProviderFailureDiagnostic(result.error)).toEqual({
      providerHttpStatus: status,
      providerErrorMessage: "Resource unavailable",
      providerErrorCode: "example_error",
    });
    expect(safeRunLogError(result.error).errorMessage).toBe("example_error: Resource unavailable");
    expect(JSON.stringify(result)).not.toContain("private-body");
  });

  it("keeps the original 403 status when rate limiting maps to 429", () => {
    const response = new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    const result = toProviderExecutionError(
      normalizeGitHubError(response, { message: "Rate limit exceeded" }, "fallback"),
      "fallback",
    );
    expect(result.error?.code).toBe("rate_limited");
    expect(safeProviderFailureDiagnostic(result.error)?.providerHttpStatus).toBe(403);
  });
});
