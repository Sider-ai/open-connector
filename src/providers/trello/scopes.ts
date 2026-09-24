export const trelloReadBoardScope = "read:board:trello";
export const trelloWriteBoardScope = "write:board:trello";
export const trelloReadMemberScope = "read:member:trello";
export const trelloReadOrganizationScope = "read:organization:trello";
export const trelloWriteOrganizationScope = "write:organization:trello";
export const trelloOfflineAccessScope = "offline_access";

/** Trello OAuth 2.0 scopes required by the bundled actions and token refresh. */
export const trelloOAuthScopes: string[] = [
  trelloReadBoardScope,
  trelloWriteBoardScope,
  trelloReadMemberScope,
  trelloReadOrganizationScope,
  trelloWriteOrganizationScope,
  trelloOfflineAccessScope,
];
