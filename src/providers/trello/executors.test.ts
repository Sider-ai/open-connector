import { describe, expect, it } from "vitest";
import { ProviderRequestError, toProviderExecutionError } from "../provider-runtime.ts";
import { credentialValidators, mapTrelloActionError } from "./executors.ts";
import { trelloActionHandlers } from "./runtime.ts";

const member = {
  id: "member-1",
  username: "ada",
  fullName: "Ada Lovelace",
};

describe("Trello credentials", () => {
  it("validates OAuth credentials with a Bearer token and records granted scopes", async () => {
    const result = await credentialValidators.oauth2!(
      {
        authType: "oauth2",
        accessToken: "trello-oauth-token",
        tokenType: "Bearer",
        profile: { accountId: "oauth2", displayName: "OAuth Credential", grantedScopes: [] },
        metadata: { scope: "read:member:trello read:board:trello,write:board:trello offline_access" },
      },
      {
        fetcher: async (url, init) => {
          const requestUrl = new URL(url.toString());
          expect(requestUrl.origin + requestUrl.pathname).toBe("https://api.trello.com/1/members/me");
          expect(requestUrl.searchParams.get("fields")).toBe("id,username,fullName");
          expect(requestUrl.searchParams.has("key")).toBe(false);
          expect(requestUrl.searchParams.has("token")).toBe(false);
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer trello-oauth-token");
          return Response.json(member);
        },
      },
    );

    expect(result).toMatchObject({
      profile: { accountId: "member-1", displayName: "Ada Lovelace" },
      grantedScopes: ["read:member:trello", "read:board:trello", "write:board:trello", "offline_access"],
      metadata: { memberId: "member-1", username: "ada" },
    });
  });

  it("keeps API key and token validation on the legacy query authentication path", async () => {
    const result = await credentialValidators.customCredential!(
      { values: { apiKey: "trello-api-key", apiToken: "trello-api-token" } },
      {
        fetcher: async (url, init) => {
          const requestUrl = new URL(url.toString());
          expect(requestUrl.searchParams.get("key")).toBe("trello-api-key");
          expect(requestUrl.searchParams.get("token")).toBe("trello-api-token");
          expect(new Headers(init?.headers).has("authorization")).toBe(false);
          return Response.json(member);
        },
      },
    );

    expect(result).toMatchObject({
      profile: { accountId: "member-1", displayName: "Ada Lovelace" },
      grantedScopes: [],
    });
  });
});

describe("Trello action errors", () => {
  it.each([
    [401, "invalid token", "Trello authentication failed (HTTP 401): invalid token"],
    [403, "unauthorized org access", "Trello denied this request (HTTP 403): unauthorized org access"],
  ])("preserves the upstream reason and HTTP %i status", async (status, upstreamMessage, expectedMessage) => {
    const error = await trelloActionHandlers
      .create_board(
        { name: "Test board" },
        {
          authType: "oauth2",
          accessToken: "test-access-token",
          fetcher: async () => Response.json({ message: upstreamMessage, error: "ERROR" }, { status }),
        },
      )
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );

    expect(toProviderExecutionError(error, "Trello request failed")).toMatchObject({
      ok: false,
      error: {
        code: "authorization_failed",
        message: expectedMessage,
        details: { status, details: { upstreamMessage } },
      },
    });
  });

  it("redacts credential material in upstream errors", async () => {
    const error = await trelloActionHandlers
      .create_board(
        { name: "Test board" },
        {
          authType: "oauth2",
          accessToken: "test-access-token",
          fetcher: async () =>
            Response.json(
              { message: "unauthorized org access\nAuthorization: Bearer sensitive-value" },
              { status: 403 },
            ),
        },
      )
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );

    const result = toProviderExecutionError(error, "Trello request failed");
    expect(JSON.stringify(result)).toContain("unauthorized org access");
    expect(JSON.stringify(result)).not.toContain("sensitive-value");
  });

  it("classifies Trello HTTP 400 invalid token as authorization failure without changing the upstream status", () => {
    expect(
      mapTrelloActionError(
        new ProviderRequestError(400, "Trello execute request failed: invalid token", {
          upstreamMessage: "invalid token",
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "authorization_failed",
        details: { status: 400, details: { upstreamMessage: "invalid token" } },
      },
    });
    expect(
      mapTrelloActionError(
        new ProviderRequestError(400, "Trello execute request failed: invalid value for name", {
          upstreamMessage: "invalid value for name",
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_input", details: { status: 400 } } });
  });
});
