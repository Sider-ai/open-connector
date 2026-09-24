import type { ExecutionContext, ResolvedCredential, TransitFileStore } from "../../core/types.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction } from "../../core/execution.ts";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { provider } from "./definition.ts";
import { credentialValidators, executors } from "./executors.ts";

interface CapturedRequest {
  url: URL;
  method: string;
  body: string;
  authorization: string | null;
  apiKey: string | null;
}

const projectRef = "abcdefghijklmnopqrst";
const oauthCredential: Extract<ResolvedCredential, { authType: "oauth2" }> = {
  authType: "oauth2",
  accessToken: "supabase-management-token",
  tokenType: "Bearer",
  profile: { accountId: "supabase:test", displayName: "Supabase test", grantedScopes: [] },
  metadata: {},
};

beforeEach(() => {
  setDefaultGuardedFetchDnsLookup(null);
});

afterEach(() => {
  setDefaultGuardedFetchDnsLookup(undefined);
  vi.unstubAllGlobals();
});

describe("Supabase OAuth scopes", () => {
  it("reports only known scopes explicitly returned with the credential", async () => {
    const fetcher = async () => Response.json([]);
    const credential = {
      ...oauthCredential,
      metadata: { scope: "projects:read database:write,unknown database:write" },
    };

    const reported = await credentialValidators.oauth2!(credential, { fetcher });
    const unknown = await credentialValidators.oauth2!(oauthCredential, { fetcher });

    expect(reported?.profile?.grantedScopes).toEqual(["projects:read", "database:write"]);
    expect(unknown?.profile?.grantedScopes).toEqual([]);
  });
});

describe("Supabase SQL actions", () => {
  it("executes writable SQL through the Management API without changing the read-only action", async () => {
    const requests = stubResponses([
      Response.json([{ created: true }], { status: 201 }),
      Response.json([{ value: 1 }]),
    ]);
    const query = "CREATE TABLE public.weather (id bigint PRIMARY KEY)";

    const writeResult = await executeSqlAction("execute_sql", { projectRef, query });
    const readResult = await executeSqlAction("run_read_only_query", { projectRef, query: "SELECT 1" });

    expect(writeResult).toEqual({ ok: true, output: { result: [{ created: true }] } });
    expect(readResult).toEqual({ ok: true, output: { result: [{ value: 1 }] } });
    expect(provider.actions.find((action) => action.name === "execute_sql")?.requiredScopes).toEqual([
      "database:write",
    ]);
    expect(requests[0]).toMatchObject({
      method: "POST",
      authorization: "Bearer supabase-management-token",
      url: expect.objectContaining({ pathname: `/v1/projects/${projectRef}/database/query` }),
    });
    expect(JSON.parse(requests[0]!.body)).toEqual({ query, read_only: false });
    expect(requests[1]?.url.pathname).toBe(`/v1/projects/${projectRef}/database/query/read-only`);
  });

  it("preserves Supabase HTTP 403 when database write permission is denied", async () => {
    stubResponses([Response.json({ message: "database write access denied" }, { status: 403 })]);

    const result = await executeSqlAction("execute_sql", { projectRef, query: "CREATE TABLE public.weather (id int)" });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "authorization_failed",
        message: "database write access denied",
        details: { status: 403 },
      },
    });
  });
});

describe("Supabase download_storage_object", () => {
  it("uses a revealed secret key and stores the exact object bytes", async () => {
    const content = new Uint8Array([83, 117, 112, 0, 255]);
    const requests = stubResponses([
      Response.json([
        apiKeyRecord({
          id: "publishable-1",
          name: "default",
          type: "publishable",
          api_key: "sb_publishable_test",
        }),
        apiKeyRecord({ id: "secret-1", name: "default", type: "secret", api_key: "sb_secret_test" }),
      ]),
      new Response(content, { headers: { "content-type": "application/pdf" } }),
    ]);
    const { store, create } = createTransitFileStore(1024);

    const result = await executeDownload(
      { projectRef, bucketId: "documents", objectPath: "reports/annual report #1.pdf" },
      store,
    );

    expect(result).toEqual({
      ok: true,
      output: {
        fileId: "documents/reports/annual report #1.pdf",
        name: "annual report #1.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        file: {
          fileId: "transit-file-1",
          downloadUrl: "http://localhost/api/files/transit-file-1",
          sizeBytes: content.length,
          name: "annual report #1.pdf",
          mimeType: "application/pdf",
        },
      },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url.pathname).toBe(`/v1/projects/${projectRef}/api-keys`);
    expect(requests[0]?.url.searchParams.get("reveal")).toBe("true");
    expect(requests[0]?.authorization).toBe("Bearer supabase-management-token");
    expect(requests[1]?.url.hostname).toBe(`${projectRef}.supabase.co`);
    expect(requests[1]?.url.pathname).toBe(
      "/storage/v1/object/authenticated/documents/reports/annual%20report%20%231.pdf",
    );
    expect(requests[1]?.apiKey).toBe("sb_secret_test");
    expect(requests[1]?.authorization).toBeNull();
    expect(create).toHaveBeenCalledOnce();
    expect(new Uint8Array(await create.mock.calls[0]![0].arrayBuffer())).toEqual(content);
  });

  it("uses Authorization only for an explicitly selected legacy service_role key", async () => {
    const requests = stubResponses([
      Response.json(
        apiKeyRecord({ id: "service-role-1", name: "service_role", type: "legacy", api_key: "legacy-jwt" }),
      ),
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    ]);
    const { store } = createTransitFileStore(1024);

    const result = await executeDownload(
      { projectRef, bucketId: "documents", objectPath: "notes.txt", apiKeyId: "service-role-1" },
      store,
    );

    expect(result.ok).toBe(true);
    expect(requests[0]?.url.pathname).toBe(`/v1/projects/${projectRef}/api-keys/service-role-1`);
    expect(requests[1]?.apiKey).toBe("legacy-jwt");
    expect(requests[1]?.authorization).toBe("Bearer legacy-jwt");
  });

  it("preserves boundary whitespace in the object path", async () => {
    const requests = stubResponses([
      Response.json([apiKeyRecord({ id: "secret-1", name: "default", type: "secret", api_key: "sb_secret_test" })]),
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    ]);
    const { store } = createTransitFileStore(1024);

    const result = await executeDownload(
      { projectRef, bucketId: "documents", objectPath: " reports/annual report.pdf " },
      store,
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        fileId: "documents/ reports/annual report.pdf ",
        name: "annual report.pdf ",
        file: { name: "annual report.pdf " },
      },
    });
    expect(requests[1]?.url.pathname).toBe(
      "/storage/v1/object/authenticated/documents/%20reports/annual%20report.pdf%20",
    );
  });

  it("rejects dot segments instead of normalizing the object path", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { store } = createTransitFileStore(1024);

    const result = await executeDownload({ projectRef, bucketId: "documents", objectPath: "a/../secret" }, store);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        message: "objectPath must not contain . or .. path segments",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors the transit size limit without storing a partial object", async () => {
    const requests = stubResponses([
      Response.json([apiKeyRecord({ id: "secret-1", name: "default", type: "secret", api_key: "sb_secret_test" })]),
      new Response(new Uint8Array([1, 2, 3])),
    ]);
    const { store, create } = createTransitFileStore(2);

    const result = await executeDownload({ projectRef, bucketId: "documents", objectPath: "large.bin" }, store);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        message: "Supabase Storage download exceeds 2 bytes",
        details: { status: 413 },
      },
    });
    expect(requests).toHaveLength(2);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns a clear error before egress when transit storage is unavailable", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const result = await executeDownload({ projectRef, bucketId: "documents", objectPath: "report.pdf" });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        message: "supabase download_storage_object requires local transit file storage",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a project reference that could change the Storage host", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { store } = createTransitFileStore(1024);

    const result = await executeDownload(
      { projectRef: "evil.example.com", bucketId: "documents", objectPath: "report.pdf" },
      store,
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

function apiKeyRecord(input: {
  id: string;
  name: string;
  type: "legacy" | "publishable" | "secret";
  api_key: string;
}): Record<string, unknown> {
  return {
    ...input,
    prefix: input.api_key.slice(0, 8),
    hash: `hash-${input.id}`,
  };
}

function stubResponses(responses: Response[]): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({
      url: new URL(request.url),
      method: request.method,
      body: await request.text(),
      authorization: request.headers.get("authorization"),
      apiKey: request.headers.get("apikey"),
    });
    const response = responses.shift();
    if (!response) {
      throw new Error(`Unexpected Supabase request to ${request.url}`);
    }
    return response;
  });
  return requests;
}

async function executeSqlAction(name: "execute_sql" | "run_read_only_query", input: Record<string, unknown>) {
  return executeAction(provider.actions.find((action) => action.name === name)!, executors[`supabase.${name}`], input, {
    getCredential: async () => oauthCredential,
  });
}

function createTransitFileStore(maxBytes: number): {
  store: TransitFileStore;
  create: ReturnType<typeof vi.fn<TransitFileStore["create"]>>;
} {
  const create = vi.fn<TransitFileStore["create"]>(async (file) => ({
    fileId: "transit-file-1",
    downloadUrl: "http://localhost/api/files/transit-file-1",
    sizeBytes: file.size,
    name: file.name,
    mimeType: file.type,
  }));
  return {
    create,
    store: {
      maxBytes,
      create,
      async read() {
        throw new Error("read is not expected in this test");
      },
      async delete() {
        return false;
      },
    },
  };
}

async function executeDownload(input: Record<string, unknown>, transitFiles?: TransitFileStore) {
  const context: ExecutionContext = {
    getCredential: async (service) => {
      expect(service).toBe("supabase");
      return oauthCredential;
    },
  };
  if (transitFiles) {
    context.transitFiles = transitFiles;
  }
  return executeAction(
    provider.actions.find((action) => action.name === "download_storage_object")!,
    executors["supabase.download_storage_object"],
    input,
    context,
  );
}
