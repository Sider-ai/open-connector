import { describe, expect, it, vi } from "vitest";
import { validateActionInput } from "../../core/validation.ts";
import { typeformActions } from "./actions.ts";
import { executors } from "./executors.ts";
import { typeformActionHandlers as handlers } from "./runtime.ts";

const id = "a1b2";
const form = {
  id,
  title: "Survey",
  _links: { display: "https://example.typeform.com/to/a1b2" },
  theme: { href: "https://api.typeform.com/themes/abc" },
  settings: { is_public: false, language: "en" },
  fields: [
    { id: "q1", ref: "first", title: "First", type: "short_text" },
    { id: "q2", type: "group", properties: { fields: [{ id: "nested", ref: "keep" }] } },
  ],
  logic: [{ type: "field", ref: "first" }],
  thankyou_screens: [{ ref: "end" }],
};
const field = { title: "Next?", type: "multiple_choice", properties: { choices: [{ label: "Yes" }] } };
function context(fetcher: typeof fetch) {
  return { accessToken: "test", fetcher };
}
const closed = () => Response.json(form, { headers: { etag: '"v1"' } });
describe("Typeform form writes", () => {
  it.each([
    ["create_form", { title: "Survey", fields: [field] }],
    ["publish_form", { formId: id }],
    ["update_form", { formId: id, renameFields: [{ id: "q1", title: "Revised" }] }],
  ] as const)("registers %s as executable with forms:write", (name, input) => {
    const a = typeformActions.find((x) => x.name === name)!;
    expect(validateActionInput(a, input).valid).toBe(true);
    expect(a.requiredScopes).toContain("forms:write");
    expect(executors[`typeform.${name}`]).toBeTypeOf("function");
  });
  it.each([
    ["create_form", { title: "Survey", settings: { is_public: true } }],
    ["update_form", { formId: id, settings: { is_public: true } }],
    ["update_form", { formId: id, fields: [] }],
    ["update_form", { formId: id }],
    ["update_form", { formId: id, addFields: [{ ...field, id: "q1" }] }],
    ["publish_form", {}],
  ] as const)("rejects unsupported input on %s", (name, input) => {
    expect(
      validateActionInput(
        typeformActions.find((x) => x.name === name)!,
        input,
      ).valid,
    ).toBe(false);
  });
  it("creates a non-public form even when called directly with caller settings", async () => {
    await expect(
      handlers.create_form(
        { title: "Survey", fields: [field], workspaceId: "w1", settings: { is_public: true } },
        context(async (url, init) => {
          expect(url.toString()).toBe("https://api.typeform.com/forms");
          expect(init?.method).toBe("POST");
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test");
          expect(JSON.parse(String(init?.body))).toEqual({
            title: "Survey",
            fields: [field],
            workspace: { href: "https://api.typeform.com/workspaces/w1" },
            settings: { is_public: false },
          });
          return closed();
        }),
      ),
    ).resolves.toEqual({ form });
  });
  it("does not report a draft if Typeform did not confirm its visibility", async () => {
    await expect(
      handlers.create_form(
        { title: "Survey" },
        context(async () => Response.json({ id })),
      ),
    ).rejects.toMatchObject({ status: 502 });
  });
  it("edits the latest retrieved definition without dropping IDs, unrelated fields, or settings", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(url.toString()).toBe("https://api.typeform.com/forms/" + id);
      if (init?.method === "GET") return closed();
      expect(init?.method).toBe("PUT");
      expect(new Headers(init?.headers).get("if-match")).toBe('"v1"');
      expect(JSON.parse(String(init?.body))).toEqual({
        title: "Revised",
        theme: form.theme,
        settings: form.settings,
        logic: form.logic,
        thankyou_screens: form.thankyou_screens,
        fields: [{ ...form.fields[0], title: "Renamed" }, form.fields[1], field],
      });
      return closed();
    });
    await expect(
      handlers.update_form(
        { formId: id, title: "Revised", renameFields: [{ id: "q1", title: "Renamed" }], addFields: [field] },
        context(fetcher),
      ),
    ).resolves.toEqual({ formId: id, updated: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("uses a narrow PATCH for a title-only edit and accepts HTTP 204", async () => {
    await expect(
      handlers.update_form(
        { formId: id, title: "New" },
        context(async (_url, init) => {
          if (init?.method === "GET") return closed();
          expect(init?.method).toBe("PATCH");
          expect(JSON.parse(String(init?.body))).toEqual([{ op: "replace", path: "/title", value: "New" }]);
          return new Response(null, { status: 204 });
        }),
      ),
    ).resolves.toEqual({ formId: id, updated: true });
  });
  it("adds the first question to a closed form without a fields array", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "GET") return Response.json({ id, title: "Empty", settings: form.settings });
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body)).fields).toEqual([field]);
      return closed();
    });
    await handlers.update_form({ formId: id, addFields: [field] }, context(fetcher));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([true, undefined])("does not edit a public form or guess visibility (%s)", async (is_public) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ...form, settings: { is_public } }));
    await expect(handlers.update_form({ formId: id, addFields: [field] }, context(fetcher))).rejects.toMatchObject({
      status: 400,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not PUT when an existing field cannot be identified", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => closed());
    await expect(
      handlers.update_form({ formId: id, renameFields: [{ id: "missing", title: "New" }] }, context(fetcher)),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("publishes only the specified form with a single visibility patch", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(url.toString()).toBe("https://api.typeform.com/forms/" + id);
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual([{ op: "replace", path: "/settings/is_public", value: true }]);
      return new Response(null, { status: 204 });
    });
    await expect(handlers.publish_form({ formId: id }, context(fetcher))).resolves.toEqual({
      formId: id,
      isPublic: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("surfaces rejected publication instead of reporting success", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ description: "Not allowed" }, { status: 403 }));
    await expect(handlers.publish_form({ formId: id }, context(fetcher))).rejects.toThrow("Not allowed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
