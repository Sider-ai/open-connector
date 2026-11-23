import { describe, expect, it } from "vitest";
import { validateActionInput } from "../../core/validation.ts";
import { netlifyActions } from "./actions.ts";
import { executors } from "./executors.ts";
import { netlifyActionHandlers } from "./runtime.ts";

describe("netlify.create_site", () => {
  const create = netlifyActions.find((action) => action.name === "create_site")!;
  const deploy = netlifyActions.find((action) => action.name === "create_site_deploy_from_zip_url")!;

  it.each([
    { input: {}, path: "/sites", body: {} },
    { input: { accountSlug: "demo-team", name: "my-demo" }, path: "/demo-team/sites", body: { name: "my-demo" } },
  ])("creates an empty site at $path and returns a deployable ID", async ({ input, path, body }) => {
    expect(executors["netlify.create_site"]).toBeTypeOf("function");
    expect(validateActionInput(create, input).valid).toBe(true);
    const result = await netlifyActionHandlers.create_site(input, {
      accessToken: "test-token",
      fetcher: async (url, init) => {
        expect(url.toString()).toBe("https://api.netlify.com/api/v1" + path);
        expect(init?.method).toBe("POST");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer test-token");
        expect(headers.get("content-type")).toBe("application/json");
        expect(JSON.parse(String(init?.body))).toEqual(body);
        return Response.json({ id: "new-id", name: "my-demo", ssl_url: null, published_deploy: null }, { status: 201 });
      },
    });
    expect(result).toEqual({ site: { id: "new-id", name: "my-demo" } });
    expect(
      validateActionInput(deploy, {
        siteId: (result as { site: { id: string } }).site.id,
        zipUrl: "https://example.com/site.zip",
      }).valid,
    ).toBe(true);
  });

  it.each([{ name: "  " }, { accountSlug: ".." }, { accountSlug: "a/b" }, { siteId: "existing" }])(
    "rejects invalid create input %j",
    (input) => {
      expect(validateActionInput(create, input).valid).toBe(false);
    },
  );

  it("propagates a rejected name without retrying in another team", async () => {
    let calls = 0;
    await expect(
      netlifyActionHandlers.create_site(
        { accountSlug: "demo-team", name: "taken-name" },
        {
          accessToken: "test-token",
          fetcher: async () => {
            calls++;
            return Response.json({ message: "Name already taken" }, { status: 422 });
          },
        },
      ),
    ).rejects.toThrow("Name already taken");
    expect(calls).toBe(1);
  });

  it("rejects a successful response missing the new site ID", async () => {
    await expect(
      netlifyActionHandlers.create_site(
        {},
        {
          accessToken: "test-token",
          fetcher: async () => Response.json({ name: "my-demo" }, { status: 201 }),
        },
      ),
    ).rejects.toMatchObject({ status: 502 });
  });
});
