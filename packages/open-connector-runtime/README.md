# @sider/open-connector-runtime

Public Node.js runtime package built from Sider's OpenConnector fork. It contains the generated provider catalog,
lazy provider executors, Action schemas and execution primitives, OAuth helpers, MCP helpers, and runtime storage
building blocks.

This package is infrastructure, not a hosted multi-user service. A consuming service must supply authentication,
tenant ownership, authorization policy, credential encryption, rate limits, and operational controls.

## Install

```sh
npm install @sider/open-connector-runtime
```

Node.js 22.18 or newer is required. The package is ESM-only and publishes compiled JavaScript plus TypeScript
declarations; consumers do not execute TypeScript from `node_modules`.

## Load the catalog and executors

```ts
import { loadCatalog } from "@sider/open-connector-runtime/catalog-store";
import { ProviderLoader } from "@sider/open-connector-runtime/providers/provider-loader";
import { executorModules } from "@sider/open-connector-runtime/providers/registry";

const catalog = await loadCatalog(undefined, {
  executableServices: Object.keys(executorModules),
});
const providerLoader = new ProviderLoader(executorModules);
```

Provider executor modules remain lazy: loading the registry or catalog does not eagerly import every provider.
Only documented subpath exports are public API.

## License

Apache-2.0. The published tarball includes the upstream license and notice files.
