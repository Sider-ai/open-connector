# @liushuangls/open-connector-runtime

Public Node.js runtime package built from Sider's OpenConnector fork. It contains the generated provider catalog,
lazy provider executors, Action schemas and execution primitives, OAuth helpers, MCP helpers, and runtime storage
building blocks.

This package is infrastructure, not a hosted multi-user service. A consuming service must supply authentication,
tenant ownership, authorization policy, credential encryption, rate limits, and operational controls.

## Install

```sh
npm install @liushuangls/open-connector-runtime
```

Node.js 22.18 or newer is required. The package is ESM-only and publishes compiled JavaScript plus TypeScript
declarations; consumers do not execute TypeScript from `node_modules`.

## Load the catalog and executors

```ts
import { loadCatalog } from "@liushuangls/open-connector-runtime/catalog-store";
import { ProviderLoader } from "@liushuangls/open-connector-runtime/providers/provider-loader";
import { executorModules } from "@liushuangls/open-connector-runtime/providers/registry";

const catalog = await loadCatalog(undefined, {
  executableServices: Object.keys(executorModules),
});
const providerLoader = new ProviderLoader(executorModules);
```

Provider executor modules remain lazy: loading the registry or catalog does not eagerly import every provider.
Only documented subpath exports are public API.

## Host-managed OAuth

Multi-user hosts can use `OAuthAuthorizationService` without giving the Runtime ownership of OAuth state or user
credentials:

```ts
import { OAuthAuthorizationService } from "@liushuangls/open-connector-runtime/oauth/oauth-authorization-service";

const oauth = new OAuthAuthorizationService({ clientConfigs });
const prepared = await oauth.prepareAuthorization({
  service: "github",
  connectionName: "work",
});

await pendingAuthorizations.set({
  principal,
  returnUrl,
  runtimeState: prepared.pending,
});

const ownedAuthorization = await pendingAuthorizations.take(callbackState);
const exchanged = await oauth.exchangeAuthorizationCode({
  pending: ownedAuthorization.runtimeState,
  code: callbackCode,
});
await principalConnections.setOAuthCredential(exchanged.service, exchanged.credential, exchanged.connectionName);
```

The host must authenticate and bind the initiating principal, encrypt `prepared.pending`, enforce a short TTL, and
consume it atomically. It must also persist `exchanged.credential` only through a principal-scoped connection store.
The pending value can contain a PKCE verifier or a custom OAuth client secret and must never be logged or returned to
the browser; only `prepared.authorizationUrl` is client-facing.

## License

Apache-2.0. The published tarball includes the upstream license and notice files.
