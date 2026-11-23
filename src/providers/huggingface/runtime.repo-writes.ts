import type { HuggingfaceActionContext } from "./runtime.shared.ts";

import { HubApiError, uploadFile } from "@huggingface/hub";
import { requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl, readBoundedResponseBytes } from "../../core/request.ts";
import { createProviderTimeout, providerFetch, ProviderRequestError } from "../provider-runtime.ts";
import {
  asRecord,
  huggingfaceRequestJson,
  readHuggingfaceCurrentUser,
  requireProviderString,
} from "./runtime.shared.ts";

const hub = "https://huggingface.co";
const maxFileBytes = 32 * 1024 * 1024;

function badInput(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

interface PersonalRepo {
  name: string;
  repoId: string;
  type: "model" | "dataset" | "space";
}

async function personalRepo(input: Record<string, unknown>, context: HuggingfaceActionContext): Promise<PersonalRepo> {
  const repoId = requiredString(input.repoId, "repoId", badInput);
  const parts = repoId.split("/");
  const [owner, name] = parts;
  if (
    parts.length !== 2 ||
    !owner ||
    !name ||
    !/^[\w-]+$/.test(owner) ||
    !/^[\w.-]{1,96}$/.test(name) ||
    /^[.-]|[.-]$|\.\.|--|\.git$/i.test(name)
  ) {
    throw badInput("repoId must identify one personal repository in username/repo-name form.");
  }
  const type = input.repoType;
  if (type !== "model" && type !== "dataset" && type !== "space") throw badInput("Invalid repoType.");
  const { preferredUsername } = await readHuggingfaceCurrentUser(context);
  if (!preferredUsername || owner.toLowerCase() !== preferredUsername.toLowerCase()) {
    throw new ProviderRequestError(403, "Choose a repository in the connected user's own personal namespace.");
  }
  return { name, repoId: `${preferredUsername}/${name}`, type };
}

/** Create only in the authenticated user's namespace; omit organization to use HF's personal default. */
export async function createPersonalRepo(
  input: Record<string, unknown>,
  context: HuggingfaceActionContext,
): Promise<unknown> {
  const visibility = input.visibility ?? "private";
  if (visibility !== "private" && visibility !== "public") throw badInput("Invalid repository visibility.");
  const sdk = input.spaceSdk;
  if (sdk !== undefined && (input.repoType !== "space" || !["static", "gradio", "docker"].includes(String(sdk)))) {
    throw badInput("spaceSdk is only supported for Spaces and must be static, gradio, or docker.");
  }
  const repo = await personalRepo(input, context);
  const result = asRecord(
    await huggingfaceRequestJson({
      ...context,
      url: hub + "/api/repos/create",
      method: "POST",
      body: {
        name: repo.name,
        type: repo.type,
        visibility,
        sdk: repo.type === "space" ? (sdk ?? "static") : undefined,
      },
    }),
  );
  return { repoId: repo.repoId, repoUrl: requireProviderString(result.url, "repository URL") };
}

async function fileContent(input: Record<string, unknown>, signal: AbortSignal): Promise<Blob> {
  if ((input.content !== undefined) === (input.fileUrl !== undefined))
    throw badInput("Specify exactly one of content or fileUrl.");
  if (input.content !== undefined) {
    if (typeof input.content !== "string") throw badInput("content must be UTF-8 text.");
    const blob = new Blob([input.content]);
    if (blob.size > maxFileBytes) throw new ProviderRequestError(413, "File exceeds 32 MiB.");
    return blob;
  }
  const url = assertPublicHttpUrl(requiredString(input.fileUrl, "fileUrl", badInput), {
    fieldName: "fileUrl",
    createError: badInput,
  });
  if (url.username || url.password) throw badInput("fileUrl must not include credentials.");
  const response = await providerFetch(url, { signal });
  if (!response.ok) throw new ProviderRequestError(502, `File download failed (HTTP ${response.status}).`);
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: maxFileBytes,
    fieldName: "file",
    createError: (m) => new ProviderRequestError(413, m),
  });
  return new Blob([Uint8Array.from(bytes)]);
}

/** Add or replace a single file by committing to an existing personal Hub repository. */
export async function uploadPersonalRepoFile(
  input: Record<string, unknown>,
  context: HuggingfaceActionContext,
): Promise<unknown> {
  const path = requiredString(input.path, "path", badInput);
  if (
    /[\\\p{Cc}]/u.test(path) ||
    path.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
  ) {
    throw badInput("path must be a repository-relative file path.");
  }
  const branch = input.branch === undefined ? "main" : requiredString(input.branch, "branch", badInput);
  if (branch.split("/").some((p) => !p || p === "." || p === "..")) throw badInput("Invalid branch.");
  const parentCommit =
    input.parentCommit === undefined ? undefined : requiredString(input.parentCommit, "parentCommit", badInput);
  if (parentCommit !== undefined && !/^[0-9a-f]{40}$/i.test(parentCommit))
    throw badInput("parentCommit must be a commit SHA.");
  const title =
    input.commitMessage === undefined
      ? `Upload ${path}`
      : requiredString(input.commitMessage, "commitMessage", badInput);
  const repo = await personalRepo(input, context);
  const timeout = createProviderTimeout(context.signal, 120_000);
  try {
    const content = await fileContent(input, timeout.signal);
    timeout.signal.throwIfAborted();
    const result = await uploadFile({
      repo: { type: repo.type, name: repo.repoId },
      file: { path, content },
      branch,
      commitTitle: title,
      parentCommit,
      hubUrl: hub,
      useXet: false,
      useWebWorkers: false,
      abortSignal: timeout.signal,
      // OAuth tokens need not have the hf_ prefix expected by the SDK's personal token option.
      // Authenticate only Hub requests, never storage URLs returned by the LFS API.
      fetch: (target, init) => {
        const url = new URL(target instanceof Request ? target.url : target.toString());
        const headers = new Headers(init?.headers);
        if (url.origin === hub) headers.set("authorization", `Bearer ${context.accessToken}`);
        return context.fetcher(target, { ...init, headers });
      },
    });
    return {
      repoId: repo.repoId,
      path,
      commitOid: requireProviderString(result?.commit.oid, "commit SHA"),
      commitUrl: requireProviderString(result?.commit.url, "commit URL"),
    };
  } catch (error) {
    if (timeout.didTimeout()) throw new ProviderRequestError(504, "Hugging Face file upload timed out.");
    if (error instanceof HubApiError)
      throw new ProviderRequestError(error.statusCode, `Hugging Face rejected the upload (HTTP ${error.statusCode}).`);
    throw error;
  } finally {
    timeout.cleanup();
  }
}
