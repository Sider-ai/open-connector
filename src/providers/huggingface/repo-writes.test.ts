import type { HuggingfaceActionContext } from "./runtime.shared.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { validateActionInput } from "../../core/validation.ts";
import { huggingfaceActions } from "./actions.ts";
import { provider } from "./definition.ts";
import { huggingfaceActionHandlers } from "./executors.ts";

const base = "https://huggingface.co";
const repo = { repoId: "alice/notes", repoType: "dataset" };
const ctx = (fetcher: typeof fetch): HuggingfaceActionContext => ({
  authType: "oauth2",
  accessToken: "oauth-not-a-pat",
  tokenType: "Bearer",
  fetcher,
});
function user() {
  return Response.json({ sub: "user-id", preferred_username: "alice" });
}
const uploadAction = huggingfaceActions.find((a) => a.name === "upload_file")!;

afterEach(() => vi.unstubAllGlobals());
describe("Hugging Face personal repository writes", () => {
  it("requests create and write permissions without full repository management", () => {
    const auth = provider.auth.find((a) => a.type === "oauth2");
    expect(auth?.scopes).toEqual(expect.arrayContaining(["read-repos", "write-repos", "contribute-repos"]));
    expect(auth?.scopes).not.toContain("manage-repos");
    expect(uploadAction.requiredScopes).toEqual(["write-repos"]);
    expect(huggingfaceActions.find((a) => a.name === "create_repo")?.requiredScopes).toEqual(["contribute-repos"]);
  });
  it.each([
    ["dataset", undefined, "private", undefined],
    ["space", "public", "public", "static"],
    ["space", undefined, "private", "docker"],
  ])("creates a personal %s repository", async (type, visibility, expectedVisibility, sdk) => {
    const calls: string[] = [];
    const result = await huggingfaceActionHandlers.create_repo(
      { ...repo, repoType: type, visibility, spaceSdk: sdk === "docker" ? sdk : undefined },
      ctx(async (u, init) => {
        calls.push(String(u));
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oauth-not-a-pat");
        if (String(u) === base + "/oauth/userinfo") return user();
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          name: "notes",
          type,
          visibility: expectedVisibility,
          ...(sdk ? { sdk } : {}),
        });
        return Response.json({ url: base + "/alice/notes" });
      }),
    );
    expect(calls).toEqual([base + "/oauth/userinfo", base + "/api/repos/create"]);
    expect(result).toMatchObject({ repoId: "alice/notes", repoUrl: base + "/alice/notes" });
  });
  it.each(["create_repo", "upload_file"] as const)("rejects other namespaces before %s writes", async (action) => {
    const fetcher = vi.fn<typeof fetch>(async () => user());
    await expect(
      huggingfaceActionHandlers[action](
        { ...repo, repoId: "some-org/notes", path: "README.md", content: "x" },
        ctx(fetcher),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["existing contents\n", ""],
    ["new contents\n", "a".repeat(40)],
  ])("commits exact file bytes with an optional parent SHA", async (contents, parent) => {
    const calls: string[] = [];
    const sha = "e".repeat(40);
    const result = await huggingfaceActionHandlers.upload_file(
      { ...repo, path: "docs/readme.md", content: contents, branch: "feat/docs", parentCommit: parent || undefined },
      ctx(async (u, init) => {
        calls.push(String(u));
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oauth-not-a-pat");
        if (String(u) === base + "/oauth/userinfo") return user();
        if (String(u).includes("/preupload/"))
          return Response.json({ files: [{ path: "docs/readme.md", uploadMode: "regular" }] });
        const [header, file] = String(init?.body)
          .split("\n")
          .map((s) => JSON.parse(s));
        expect(header.value.parentCommit).toBe(parent || undefined);
        expect(file.key).toBe("file");
        expect(file.value.path).toBe("docs/readme.md");
        expect(Buffer.from(file.value.content, "base64").toString()).toBe(contents);
        return Response.json({ commitOid: sha, commitUrl: base + "/commit/" + sha });
      }),
    );
    expect(calls).toEqual([
      base + "/oauth/userinfo",
      base + "/api/datasets/alice/notes/preupload/feat%2Fdocs",
      base + "/api/datasets/alice/notes/commit/feat%2Fdocs",
    ]);
    expect(result).toMatchObject({ commitOid: sha, path: "docs/readme.md" });
  });
  it("forwards binary bytes via LFS without sending HF credentials to storage", async () => {
    const bytes = Uint8Array.of(0, 255, 42);
    // A literal public IP lets the shared guard validate without doing a real DNS lookup.
    const download = vi.fn<typeof fetch>(async (_u, init) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response(bytes);
    });
    vi.stubGlobal("fetch", download);
    let uploaded = false;
    const path = "sample.bin";
    const result = await huggingfaceActionHandlers.upload_file(
      { ...repo, path, fileUrl: "https://93.184.216.34/sample.bin" },
      ctx(async (u, init) => {
        if (String(u) === base + "/oauth/userinfo") return user();
        if (String(u).includes("/preupload/")) return Response.json({ files: [{ path, uploadMode: "lfs" }] });
        if (String(u).endsWith("/objects/batch")) {
          const [obj] = JSON.parse(String(init?.body)).objects;
          return Response.json({
            transfer: "basic",
            objects: [{ ...obj, actions: { upload: { href: "https://storage.example.org/signed" } } }],
          });
        }
        if (String(u) === "https://storage.example.org/signed") {
          expect(new Headers(init?.headers).has("authorization")).toBe(false);
          expect(Array.from(new Uint8Array(await new Response(init?.body).arrayBuffer()))).toEqual([...bytes]);
          uploaded = true;
          return new Response(null, { status: 200 });
        }
        expect(uploaded).toBe(true);
        expect(JSON.parse(String(init?.body).split("\n")[1]!).key).toBe("lfsFile");
        return Response.json({ commitOid: "sha", commitUrl: base + "/commit/sha" });
      }),
    );
    expect(download).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ commitOid: "sha" });
  });
  it("surfaces denied or stale writes without retrying or creating a repository", async () => {
    const calls: string[] = [];
    await expect(
      huggingfaceActionHandlers.upload_file(
        { ...repo, path: "README.md", content: "" },
        ctx(async (u) => {
          calls.push(String(u));
          if (String(u) === base + "/oauth/userinfo") return user();
          if (String(u).includes("/preupload/"))
            return Response.json({ files: [{ path: "README.md", uploadMode: "regular" }] });
          return Response.json({ error: "conflict" }, { status: 409 });
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(3);
  });
  it.each([
    { path: "../outside.md", content: "x", status: 400 },
    { path: "README.md", fileUrl: "http://127.0.0.1/secret", status: 400 },
  ])("rejects unsafe inputs before writing to HF", async ({ status, ...input }) => {
    const fetcher = vi.fn<typeof fetch>(async (target) => {
      expect(String(target)).toBe(base + "/oauth/userinfo");
      return user();
    });
    await expect(huggingfaceActionHandlers.upload_file({ ...repo, ...input }, ctx(fetcher))).rejects.toMatchObject({
      status,
    });
  });
  it("refuses oversized sources before starting a commit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () => new Response(null, { headers: { "content-length": String(32 * 1024 * 1024 + 1) } }),
      ),
    );
    const fetcher = vi.fn<typeof fetch>(async () => user());
    await expect(
      huggingfaceActionHandlers.upload_file({ ...repo, path: "x", fileUrl: "https://93.184.216.34/x" }, ctx(fetcher)),
    ).rejects.toMatchObject({ status: 413 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects missing or conflicting file sources and preserves empty text", () => {
    const input = { ...repo, path: "notes.md" };
    expect(validateActionInput(uploadAction, input).valid).toBe(false);
    expect(validateActionInput(uploadAction, { ...input, content: "", fileUrl: "https://files.example/x" }).valid).toBe(
      false,
    );
    expect(validateActionInput(uploadAction, { ...input, content: "" }).valid).toBe(true);
  });
});
