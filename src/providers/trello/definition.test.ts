import { describe, expect, it } from "vitest";
import { provider } from "./definition.ts";
import { trelloOAuthScopes } from "./scopes.ts";

describe("Trello provider definition", () => {
  it("declares the confidential PKCE flow and refresh-token scope", () => {
    const oauth = provider.auth.find((auth) => auth.type === "oauth2");

    expect(oauth).toMatchObject({
      authorizationUrl: "https://auth.atlassian.com/authorize",
      tokenUrl: "https://auth.atlassian.com/oauth/token",
      scopes: trelloOAuthScopes,
      tokenEndpointAuthMethod: "client_secret_post",
      tokenRequestFormat: "json",
      pkce: { method: "S256" },
      authorizationParams: { prompt: "consent" },
    });
  });
});
