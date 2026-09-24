import { describe, expect, it } from "vitest";
import { provider } from "./definition.ts";

describe("Trello provider definition", () => {
  it("declares the confidential PKCE flow, workspace write scope, and refresh-token scope", () => {
    const oauth = provider.auth.find((auth) => auth.type === "oauth2");

    expect(oauth).toMatchObject({
      authorizationUrl: "https://auth.atlassian.com/authorize",
      tokenUrl: "https://auth.atlassian.com/oauth/token",
      scopes: [
        "read:board:trello",
        "write:board:trello",
        "read:member:trello",
        "read:organization:trello",
        "write:organization:trello",
        "offline_access",
      ],
      tokenEndpointAuthMethod: "client_secret_post",
      tokenRequestFormat: "json",
      pkce: { method: "S256" },
      authorizationParams: { prompt: "consent" },
    });
  });
});
