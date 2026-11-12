import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../../core/execution.ts";
import { validateActionInput } from "../../core/validation.ts";
import { safeProviderFailureDiagnostic, safeRunLogError } from "../../server/actions/run-log-summary.ts";
import { renderActionMarkdown } from "../../server/api/action-markdown.ts";
import { toProviderExecutionError } from "../provider-runtime.ts";
import { githubActions } from "./actions.ts";
import { pullRequestActionHandlers } from "./runtime-pull-request.ts";
import { repositoryActionHandlers } from "./runtime-repository.ts";
import { normalizeGitHubError } from "./runtime-shared.ts";

const jobsAction = githubActions.find((action) => action.name === "list_workflow_run_jobs")!;
const writeAction = githubActions.find((action) => action.name === "create_or_update_file")!;
const updateAction = githubActions.find((action) => action.name === "update_file")!;
const readAction = githubActions.find((action) => action.name === "get_file_contents")!;
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

describe("GitHub file update workflow", () => {
  it("exposes the read-to-update workflow and required sha in action guides", () => {
    expect(readAction.followUpActions).toContain(updateAction.id);
    expect(renderActionMarkdown(readAction)).toContain("github.update_file");
    const guide = renderActionMarkdown(updateAction);
    expect(guide.replaceAll("\\_", "_")).toContain("github.get_file_contents");
    expect(guide).toContain("same branch");
    expect(guide).toContain("at least one of these input groups");
    const example = JSON.parse(guide.match(/-d '([^'\n]+)'/u)![1]!).input;
    expect(example.content).toBe("<content>");
    expect(validateActionInput(updateAction, example).valid).toBe(true);
    expect(updateAction.inputSchema.required).toContain("sha");
    expect(writeAction.inputSchema.required).not.toContain("sha");
    expect(writeAction.description).toContain("Prefer github.update_file");
  });

  it.each([undefined, null, "", " ", 123])("rejects an invalid update sha before execution: %j", async (sha) => {
    const executor = vi.fn(async () => ({ ok: true, output: {} }));
    const input = { ...file, content: "updated", ...(sha === undefined ? {} : { sha }) };
    const result = await executeAction(updateAction, executor, input, { getCredential: async () => undefined });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(safeRunLogError(result.error, updateAction).errorMessage).toContain("sha");
    expect(executor).not.toHaveBeenCalled();
  });

  it.each([{}, { content: null }, { contentBase64: 123 }])(
    "requires explicit string contents even when an update sha is present: %j",
    async (fields) => {
      const executor = vi.fn(async () => ({ ok: true, output: {} }));
      const result = await executeAction(
        updateAction,
        executor,
        { ...file, sha: "current-sha", ...fields },
        { getCredential: async () => undefined },
      );
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(executor).not.toHaveBeenCalled();
    },
  );

  it("guards the update precondition when the handler is called directly", () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() =>
      repositoryActionHandlers.update_file!({ ...file, content: "updated" }, { accessToken: "mock-token", fetcher }),
    ).toThrow("Provide sha from github.get_file_contents");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([undefined, "feature/docs"])("reads and updates the same branch: %j", async (branch) => {
    const sha = "a".repeat(40);
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe("/repos/example/project/contents/file.txt");
      if (init?.method === "GET") {
        expect(new URL(String(url)).searchParams.get("ref")).toBe(branch ?? null);
        return Response.json({
          type: "file",
          sha,
          encoding: "base64",
          content: Buffer.from("original").toString("base64"),
        });
      }
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({
        message: file.message,
        content: Buffer.from("original\n更新 🙂").toString("base64"),
        sha,
        ...(branch === undefined ? {} : { branch }),
      });
      return Response.json({ commit: { sha: "new-commit" } });
    });
    const context = { accessToken: "mock-token", fetcher };
    const read = (await repositoryActionHandlers.get_file_contents!(
      { ...repo, path: file.path, ref: branch },
      context,
    )) as Record<string, unknown>;
    const input = {
      ...file,
      content: `${read.decoded_content}\n更新 🙂`,
      sha: read.sha,
      ...(branch === undefined ? {} : { branch }),
    };
    expect(validateActionInput(updateAction, input).valid).toBe(true);
    await expect(repositoryActionHandlers.update_file!(input, context)).resolves.toEqual({
      commit: { sha: "new-commit" },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([{ content: "" }, { contentBase64: "" }])("allows an explicit empty update: %j", async (contents) => {
    const input = { ...file, sha: "current-sha", ...contents };
    expect(validateActionInput(updateAction, input).valid).toBe(true);
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ content: "", sha: "current-sha" });
      return Response.json({ commit: { sha: "new-commit" } });
    });
    await repositoryActionHandlers.update_file!(input, { accessToken: "mock-token", fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves legacy creation without a sha or an implicit read", async () => {
    const input = { ...file, content: "new file" };
    expect(validateActionInput(writeAction, input).valid).toBe(true);
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).not.toHaveProperty("sha");
      return Response.json({ commit: { sha: "new-commit" } }, { status: 201 });
    });
    await repositoryActionHandlers.create_or_update_file!(input, { accessToken: "mock-token", fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns a stale-sha conflict without fetching a new sha or retrying the write", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body)).sha).toBe("stale-sha");
      return Response.json({ message: "File sha does not match" }, { status: 409 });
    });
    await expect(
      repositoryActionHandlers.update_file!(
        { ...file, content: "updated", sha: "stale-sha" },
        { accessToken: "mock-token", fetcher },
      ),
    ).rejects.toMatchObject({ details: { upstreamStatus: 409 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub local input diagnostics", () => {
  it.each([
    { handler: repositoryActionHandlers.get_file_contents!, payload: [], reason: "path_is_directory" },
    {
      handler: repositoryActionHandlers.get_file_contents!,
      payload: { type: "symlink" },
      reason: "path_not_regular_file",
    },
    {
      handler: repositoryActionHandlers.list_directory_contents!,
      payload: { type: "file" },
      reason: "path_not_directory",
    },
  ])("records $reason without an upstream failure status", async ({ handler, payload, reason }) => {
    const result = await handler(
      { ...repo, path: "private-path" },
      { accessToken: "mock-token", fetcher: async () => Response.json(payload) },
    ).then(
      () => {
        throw new Error("Expected local input rejection");
      },
      (error: unknown) => toProviderExecutionError(error, "fallback"),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input", details: { status: 400, details: { inputErrorCode: reason } } },
    });
    const audit = safeRunLogError(result.error);
    expect(audit.errorMessage).toContain(`${reason}: `);
    expect(audit.errorMessage).not.toContain("private-path");
    expect(safeProviderFailureDiagnostic(result.error)).toBeUndefined();
  });

  it("records conflicting workflow aliases without making a provider request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await pullRequestActionHandlers.list_workflow_run_jobs!(
      { ...repo, runId: 123, run_id: 456 },
      { accessToken: "mock-token", fetcher },
    ).catch((error: unknown) => toProviderExecutionError(error, "fallback"));
    expect(result).toMatchObject({ error: { details: { details: { inputErrorCode: "conflicting_aliases" } } } });
    expect(fetcher).not.toHaveBeenCalled();
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
