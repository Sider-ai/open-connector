export const supabaseScopes = {
  organizationsRead: "organizations:read",
  projectsRead: "projects:read",
  secretsRead: "secrets:read",
  secretsWrite: "secrets:write",
  databaseRead: "database:read",
  databaseWrite: "database:write",
  storageRead: "storage:read",
  edgeFunctionsRead: "edge_functions:read",
} as const;

export const supabaseProviderScopes: string[] = Object.values(supabaseScopes);
