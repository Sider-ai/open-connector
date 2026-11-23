import type { ProviderFetch } from "../provider-runtime.ts";

import { describe, expect, it } from "vitest";
import { validateActionInput } from "../../core/validation.ts";
import { miroActions } from "./actions.ts";
import { credentialValidators, executors, miroActionHandlers } from "./executors.ts";

const actionContext = {
  accessToken: "miro-access-token",
  tokenType: "Bearer",
};

interface WriteActionCase {
  action: keyof typeof miroActionHandlers;
  method: string;
  path: string;
  input: Record<string, unknown>;
  body: unknown;
  response: unknown;
  result: unknown;
}

describe("Miro board organization and diagram actions", () => {
  const boardId = "source=1";
  const boardPath = "/v2/boards/source%3D1";
  const frame = { data: { title: "Ideas" }, style: { fillColor: "#ffffff" }, geometry: { width: 800, height: 600 } };
  const shape = {
    data: { shape: "rhombus", content: "Ready?" },
    parent: { id: "frame1" },
    position: { x: 150, y: 80 },
  };
  const connector = {
    startItem: { id: "a", snapTo: "right" },
    endItem: { id: "b" },
    shape: "elbowed",
    captions: [{ content: "Yes" }],
  };
  const copy = { name: "Week two", teamId: "team1", description: "New sprint" };
  const notes = [
    { type: "sticky_note", data: { content: "First" } },
    { type: "shape", ...shape },
  ];
  const item = { id: "item1", type: "sticky_note" };
  const cases: WriteActionCase[] = [
    {
      action: "copy_board",
      method: "PUT",
      path: "/v2/boards?copy_from=source%3D1",
      input: copy,
      body: copy,
      response: { id: "copy1", name: "Week two" },
      result: { board: { id: "copy1", name: "Week two" } },
    },
    {
      action: "create_frame",
      method: "POST",
      path: boardPath + "/frames",
      input: frame,
      body: frame,
      response: { id: "frame1", type: "frame" },
      result: { item: { id: "frame1", type: "frame" } },
    },
    {
      action: "move_item",
      method: "PATCH",
      path: boardPath + "/items/item1",
      input: { itemId: "item1", parent: { id: null } },
      body: { parent: { id: null } },
      response: item,
      result: { item },
    },
    {
      action: "move_item",
      method: "PATCH",
      path: boardPath + "/items/item1",
      input: { itemId: "item1", parent: shape.parent, position: shape.position },
      body: { parent: shape.parent, position: shape.position },
      response: item,
      result: { item },
    },
    {
      action: "create_items_bulk",
      method: "POST",
      path: boardPath + "/items/bulk",
      input: { items: notes },
      body: notes,
      response: { type: "fixed-list", data: [item, { id: "item2", type: "shape" }] },
      result: { items: [item, { id: "item2", type: "shape" }] },
    },
    {
      action: "create_shape",
      method: "POST",
      path: boardPath + "/shapes",
      input: shape,
      body: shape,
      response: { id: "a", type: "shape" },
      result: { item: { id: "a", type: "shape" } },
    },
    {
      action: "create_connector",
      method: "POST",
      path: boardPath + "/connectors",
      input: connector,
      body: connector,
      response: { id: "c", ...connector },
      result: { connector: { id: "c", ...connector } },
    },
  ];

  it.each(cases)(
    "$action sends $method $path and maps the response",
    async ({ action, method, path, input, body, response, result }) => {
      const definition = miroActions.find((a) => a.name === action)!;
      expect(executors[`miro.${action}`]).toBeTypeOf("function");
      expect(definition.requiredScopes).toEqual(["boards:write"]);
      expect(validateActionInput(definition, { boardId, ...input }).valid).toBe(true);
      const fetcher: ProviderFetch = async (url, init) => {
        expect(url.toString()).toBe("https://api.miro.com" + path);
        expect(init?.method).toBe(method);
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer miro-access-token");
        expect(headers.get("content-type")).toBe("application/json");
        expect(JSON.parse(String(init?.body))).toEqual(body);
        return Response.json(response);
      };
      await expect(miroActionHandlers[action]({ boardId, ...input }, { ...actionContext, fetcher })).resolves.toEqual(
        result,
      );
    },
  );

  it.each([
    ["copy_board", { name: "Missing source" }],
    ["move_item", { boardId, itemId: "item1" }],
    ["move_item", { boardId, itemId: "item1", parent: {} }],
    ["move_item", { boardId, itemId: "item1", position: {} }],
    ["create_frame", { boardId }],
    ["create_shape", { boardId, data: { shape: "not-a-shape" } }],
    ["create_connector", { boardId, startItem: { id: "item1" } }],
    ["create_items_bulk", { boardId, items: [] }],
    ["create_items_bulk", { boardId, items: Array(21).fill(notes[0]) }],
    ["create_items_bulk", { boardId, items: [{ type: "connector" }] }],
  ])("rejects invalid %s input", (name, input) => {
    expect(validateActionInput(miroActions.find((a) => a.name === name)!, input).valid).toBe(false);
  });

  it("rejects self-connections before contacting Miro", async () => {
    await expect(
      miroActionHandlers.create_connector(
        { boardId, startItem: { id: "a" }, endItem: { id: "a" } },
        {
          ...actionContext,
          fetcher: async () => {
            throw new Error("unexpected request");
          },
        },
      ),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("different items") });
  });

  it("keeps a rejected batch atomic and surfaces Miro's error", async () => {
    let calls = 0;
    await expect(
      miroActionHandlers.create_items_bulk(
        { boardId, items: notes },
        {
          ...actionContext,
          fetcher: async () => {
            calls++;
            return Response.json({ message: "Invalid item" }, { status: 400 });
          },
        },
      ),
    ).rejects.toMatchObject({ status: 400, message: "Invalid item" });
    expect(calls).toBe(1);
  });
});

describe("Miro OAuth credentials", () => {
  it("validates the token through its access-token context", async () => {
    const result = await credentialValidators.oauth2!(
      {
        authType: "oauth2",
        accessToken: "miro-access-token",
        tokenType: "Bearer",
        profile: { accountId: "oauth2", displayName: "OAuth Credential", grantedScopes: [] },
        metadata: {},
      },
      {
        fetcher: async (input, init) => {
          expect(input.toString()).toBe("https://api.miro.com/v1/oauth-token");
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer miro-access-token");
          return Response.json({
            id: "token-123",
            scopes: ["boards:read", "boards:write"],
            user: { id: "user-123", name: "Alice", type: "user" },
            team: { id: "team-123", name: "Product", type: "team" },
            createdAt: "2026-08-13T12:00:00Z",
          });
        },
      },
    );

    expect(result).toMatchObject({
      profile: {
        accountId: "user-123",
        displayName: "Alice (Product)",
        grantedScopes: ["boards:read", "boards:write"],
      },
      grantedScopes: ["boards:read", "boards:write"],
      metadata: {
        apiBaseUrl: "https://api.miro.com",
        validationEndpoint: "/v1/oauth-token",
        tokenId: "token-123",
        currentUser: { id: "user-123", name: "Alice" },
        team: { id: "team-123", name: "Product" },
      },
    });
  });
});

describe("Miro board actions", () => {
  it("maps board filters and offset pagination to the v2 API", async () => {
    const fetcher: ProviderFetch = async (input, init) => {
      const url = new URL(input.toString());
      expect(url.pathname).toBe("/v2/boards");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        team_id: "team-123",
        query: "roadmap",
        limit: "5",
        offset: "10",
        sort: "last_modified",
      });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer miro-access-token");
      return Response.json({
        size: 1,
        limit: 5,
        offset: 10,
        data: [{ id: "board-123", name: "Roadmap", type: "board" }],
      });
    };

    await expect(
      miroActionHandlers.list_boards!(
        { teamId: "team-123", query: "roadmap", limit: 5, offset: 10, sort: "last_modified" },
        { ...actionContext, fetcher },
      ),
    ).resolves.toEqual({
      boards: [{ id: "board-123", name: "Roadmap", type: "board" }],
      pagination: { limit: 5, offset: 10, size: 1 },
    });
  });
});

describe("Miro item actions", () => {
  it("creates a sticky note with provider-native nested fields", async () => {
    const fetcher: ProviderFetch = async (input, init) => {
      expect(new URL(input.toString()).pathname).toBe("/v2/boards/board-123/sticky_notes");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        data: { content: "Ship it", shape: "square" },
        style: { fillColor: "light_yellow" },
        position: { x: 10, y: 20 },
        geometry: { width: 240 },
      });
      return Response.json({ id: "item-123", type: "sticky_note", data: { content: "Ship it" } });
    };

    await expect(
      miroActionHandlers.create_sticky_note!(
        {
          boardId: "board-123",
          data: { content: "Ship it", shape: "square" },
          style: { fillColor: "light_yellow" },
          position: { x: 10, y: 20 },
          geometry: { width: 240 },
        },
        { ...actionContext, fetcher },
      ),
    ).resolves.toEqual({
      item: { id: "item-123", type: "sticky_note", data: { content: "Ship it" } },
    });
  });

  it("rejects conflicting sticky-note dimensions before making a request", async () => {
    const fetcher: ProviderFetch = async () => {
      throw new Error("fetch should not run");
    };
    await expect(
      miroActionHandlers.create_sticky_note!(
        {
          boardId: "board-123",
          data: { content: "Ship it" },
          geometry: { width: 240, height: 120 },
        },
        { ...actionContext, fetcher },
      ),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("either width or height") });
  });

  it("rejects text-item height before making a request", async () => {
    const fetcher: ProviderFetch = async () => {
      throw new Error("fetch should not run");
    };

    await expect(
      miroActionHandlers.create_text!(
        {
          boardId: "board-123",
          data: { content: "Ship it" },
          geometry: { width: 240, height: 120 },
        },
        { ...actionContext, fetcher },
      ),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("geometry.height") });
  });
});
