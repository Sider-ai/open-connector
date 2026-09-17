import { describe, expect, it } from "vitest";
import { credentialValidators } from "./executors.ts";

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
