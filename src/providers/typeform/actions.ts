import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { typeformFormsWriteScope } from "./scopes.ts";

const service = "typeform";

const accountsReadScope = ["accounts:read"];
const formsReadScope = ["forms:read"];
const responsesReadScope = ["responses:read"];
const workspacesReadScope = ["workspaces:read"];

const noInputSchema = s.object("No input parameters are required for this action.", {});
const looseNamedObjectSchema = s.looseObject("A raw nested object returned by the Typeform API.");

const accountSchema = s.looseObject("The Typeform account reference returned for the current user.", {
  id: s.string("The Typeform account identifier."),
  href: s.string("The API URL for the Typeform account."),
});

const currentUserSchema = s.looseObject("The current Typeform user returned by the account API.", {
  alias: s.string("The alias or display name of the current Typeform user."),
  email: s.string("The email address of the current Typeform user."),
  language: s.string("The language code configured on the current user."),
  href: s.string("The API URL for the current user resource."),
  account: accountSchema,
});

const workspaceSchema = s.looseObject("A Typeform workspace object.", {
  id: s.nonEmptyString("The Typeform workspace identifier."),
  href: s.string("The API URL for this workspace."),
  name: s.string("The workspace name."),
  forms: s.looseObject("The forms summary returned for a Typeform workspace.", {
    href: s.string("The API URL for the forms collection in this workspace."),
    count: s.nonNegativeInteger("The number of forms in this workspace."),
  }),
  members: s.array(
    "The members returned for this workspace.",
    s.looseObject("One workspace member returned by Typeform.", {
      name: s.string("The full name of the workspace member."),
      email: s.string("The email address of the workspace member."),
      role: s.string("The role assigned to the workspace member."),
    }),
  ),
});

const formSummarySchema = s.looseObject("A Typeform form summary returned by the list-forms endpoint.", {
  id: s.nonEmptyString("The Typeform form identifier."),
  title: s.string("The title of the form."),
  theme: s.looseObject("The Typeform theme reference returned on a form.", {
    href: s.string("The API URL for the theme used by this form."),
  }),
  _links: s.looseObject("The related links returned on a Typeform form.", {
    self: s.looseObject("A self link returned by Typeform.", {
      href: s.string("The API URL for the current form resource."),
    }),
    display: s.string("The public URL used to display the form."),
    responses: s.string("The API URL used to retrieve responses for the form."),
  }),
  settings: s.looseObject("A subset of Typeform settings returned on a form summary.", {
    is_public: s.boolean("Whether the form is publicly accessible."),
  }),
  workspace: s.looseObject("The workspace reference returned on a Typeform form.", {
    href: s.string("The API URL for the workspace that owns the form."),
  }),
  created_at: s.string("The timestamp when the form was created."),
  last_updated_at: s.string("The timestamp when the form was last updated."),
});

const formFieldSchema = s.looseObject("One field definition returned by Typeform.", {
  id: s.string("The field identifier."),
  ref: s.string("The developer-defined field reference."),
  title: s.string("The title shown for the field."),
  type: s.string("The Typeform field type."),
  properties: s.looseObject("The raw field properties returned by Typeform."),
  validations: s.looseObject("The field validations returned by Typeform."),
});

const fullFormSchema = s.looseObject("A full Typeform form payload.", {
  id: s.nonEmptyString("The Typeform form identifier."),
  title: s.string("The title of the form."),
  type: s.string("The form type returned by Typeform."),
  language: s.string("The language code configured on the form."),
  hidden: s.stringArray("The hidden field keys configured on the form."),
  captcha: s.boolean("Whether CAPTCHA is enabled on the form."),
  fields: s.array("The fields configured on the form.", formFieldSchema),
  logic: s.array("The logic rules configured on the form.", looseNamedObjectSchema),
  theme: looseNamedObjectSchema,
  workspace: looseNamedObjectSchema,
  settings: looseNamedObjectSchema,
  variables: looseNamedObjectSchema,
  links: looseNamedObjectSchema,
  meta: looseNamedObjectSchema,
  cui_settings: s.looseObject("The conversational UI settings returned for the form."),
  duplicate_prevention: s.looseObject("The duplicate prevention settings returned for the form."),
  welcome_screens: s.array("The welcome screens configured on the form.", looseNamedObjectSchema),
  thankyou_screens: s.array("The thank-you screens configured on the form.", looseNamedObjectSchema),
});

const responseItemSchema = s.looseObject("One Typeform response item.", {
  landing_id: s.string("The Typeform response landing identifier."),
  token: s.string("The Typeform response token."),
  response_id: s.string("The Typeform response identifier."),
  landed_at: s.string("When the respondent landed on the form."),
  submitted_at: s.string("When the respondent submitted the form."),
  metadata: looseNamedObjectSchema,
  hidden: looseNamedObjectSchema,
  calculated: looseNamedObjectSchema,
  variables: s.array("Variables returned with the response.", looseNamedObjectSchema),
  answers: s.array("Answers submitted with the response.", looseNamedObjectSchema),
});

const listFormsInputSchema = s.object(
  "Parameters for listing Typeform forms.",
  {
    page: s.positiveInteger("Optional page number to retrieve."),
    search: s.nonEmptyString("Optional search query used to filter forms."),
    sortBy: s.stringEnum("Field used by Typeform to sort forms.", ["created_at", "last_updated_at"]),
    orderBy: s.stringEnum("Sort order used by Typeform.", ["asc", "desc"]),
    pageSize: s.integer("Optional page size for forms.", { minimum: 1, maximum: 200 }),
    workspaceId: s.nonEmptyString("Optional workspace ID used to filter forms."),
  },
  { optional: ["page", "search", "sortBy", "orderBy", "pageSize", "workspaceId"] },
);

const getFormInputSchema = s.object("Parameters for retrieving one Typeform form.", {
  formId: s.nonEmptyString("The Typeform form ID."),
});

const listFormResponsesInputSchema = s.object(
  "Parameters for listing responses submitted to one Typeform form.",
  {
    formId: s.nonEmptyString("The Typeform form ID."),
    pageSize: s.integer("Optional response page size.", { minimum: 1, maximum: 1000 }),
    since: s.string("Optional lower timestamp bound for responses."),
    until: s.string("Optional upper timestamp bound for responses."),
    after: s.string("Optional response token used as an exclusive lower cursor."),
    before: s.string("Optional response token used as an exclusive upper cursor."),
    query: s.string("Optional text query used by Typeform to filter responses."),
    sort: s.string("Optional Typeform response sort expression."),
    fields: s.stringArray("Optional field IDs to include."),
    responseType: s.stringArray("Optional Typeform response types to include."),
    answeredFields: s.stringArray("Optional answered field IDs to include."),
    includedResponseIds: s.stringArray("Optional response IDs to include."),
    excludedResponseIds: s.stringArray("Optional response IDs to exclude."),
  },
  {
    optional: [
      "pageSize",
      "since",
      "until",
      "after",
      "before",
      "query",
      "sort",
      "fields",
      "responseType",
      "answeredFields",
      "includedResponseIds",
      "excludedResponseIds",
    ],
  },
);

const listWorkspacesInputSchema = s.object(
  "Parameters for listing Typeform workspaces.",
  {
    page: s.positiveInteger("Optional page number to retrieve."),
    search: s.nonEmptyString("Optional search query used to filter workspaces."),
    pageSize: s.integer("Optional page size for workspaces.", { minimum: 1, maximum: 200 }),
  },
  { optional: ["page", "search", "pageSize"] },
);

const getWorkspaceInputSchema = s.object("Parameters for retrieving one Typeform workspace.", {
  workspaceId: s.nonEmptyString("The Typeform workspace ID."),
});

const listOutputSchema = (description: string, itemDescription: string, itemSchema: Record<string, unknown>) =>
  s.object(description, {
    items: s.array(itemDescription, itemSchema),
    pageCount: s.nonNegativeInteger("The total number of available pages."),
    totalItems: s.nonNegativeInteger("The total number of matching items."),
  });

const formId = s.nonWhitespaceString("The ID of the exact Typeform form.");
const formTitle = s.nonWhitespaceString("Form title.");
const newQuestion = s.requiredObject("A new question, without an existing field ID.", {
  title: s.nonWhitespaceString("Question shown to the respondent."),
  type: s.nonWhitespaceString("Typeform field type, e.g. short_text, email, or multiple_choice."),
  ref: s.optional(s.nonWhitespaceString("Unique developer reference.")),
  properties: s.optional(s.unknownObject("Type-specific properties, e.g. choices for multiple_choice.")),
  validations: s.optional(s.unknownObject("Validation settings, e.g. required.")),
});
const writeFormOutput = s.requiredObject("The resulting Typeform form.", { form: fullFormSchema });

export const typeformActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "create_form",
    operationType: "write",
    description:
      "Create a closed Typeform form with optional questions. It does not accept responses until publish_form is called.",
    requiredScopes: [typeformFormsWriteScope],
    inputSchema: s.requiredObject("New non-public form.", {
      title: formTitle,
      fields: s.optional(s.array(newQuestion)),
      workspaceId: s.optional(s.nonWhitespaceString("Optional destination workspace ID.")),
    }),
    outputSchema: writeFormOutput,
  }),
  defineProviderAction(service, {
    name: "update_form",
    operationType: "write",
    description:
      "Edit a non-public form: rename the form, append new questions, or rename existing questions by field ID. Does not delete questions or publish the form.",
    requiredScopes: [...formsReadScope, typeformFormsWriteScope],
    inputSchema: s.requireAnyProperty(
      s.requiredObject("Changes to a non-public form.", {
        formId,
        title: s.optional(formTitle),
        addFields: s.optional(s.array(newQuestion, { minItems: 1 })),
        renameFields: s.optional(
          s.array(
            s.requiredObject("An existing question to rename.", {
              id: s.nonWhitespaceString("Field ID returned by get_form."),
              title: s.nonWhitespaceString("New question title."),
            }),
            { minItems: 1 },
          ),
        ),
      }),
      ["title", "addFields", "renameFields"],
    ),
    outputSchema: s.requiredObject("Result of editing the form.", {
      formId,
      updated: s.boolean("Whether Typeform accepted the edit."),
    }),
  }),
  defineProviderAction(service, {
    name: "publish_form",
    operationType: "write",
    description:
      "Make this form public and open it for responses. Use this action for publication, not for saving edits.",
    requiredScopes: [typeformFormsWriteScope],
    inputSchema: s.requiredObject("Target form to make public.", { formId }),
    outputSchema: s.requiredObject("Publication result.", {
      formId,
      isPublic: s.boolean("Whether the form is public."),
    }),
  }),
  defineProviderAction(service, {
    name: "get_current_user",
    operationType: "read",
    description: "Get the current Typeform user associated with the authenticated personal access token.",
    requiredScopes: accountsReadScope,
    inputSchema: noInputSchema,
    outputSchema: s.object("The normalized current-user response returned by Typeform.", {
      user: currentUserSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "list_forms",
    operationType: "read",
    description: "List forms available to the authenticated Typeform account.",
    requiredScopes: formsReadScope,
    inputSchema: listFormsInputSchema,
    outputSchema: listOutputSchema(
      "The normalized paginated form list returned by Typeform.",
      "The forms returned for this page.",
      formSummarySchema,
    ),
  }),
  defineProviderAction(service, {
    name: "get_form",
    operationType: "read",
    description: "Get one Typeform form by form ID.",
    requiredScopes: formsReadScope,
    inputSchema: getFormInputSchema,
    outputSchema: s.object("The normalized single-form response returned by Typeform.", {
      form: fullFormSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "list_form_responses",
    operationType: "read",
    description: "List responses submitted to one Typeform form.",
    requiredScopes: responsesReadScope,
    inputSchema: listFormResponsesInputSchema,
    outputSchema: listOutputSchema(
      "The normalized response list returned by Typeform.",
      "The responses returned for this page.",
      responseItemSchema,
    ),
  }),
  defineProviderAction(service, {
    name: "list_workspaces",
    operationType: "read",
    description: "List workspaces available to the authenticated Typeform account.",
    requiredScopes: workspacesReadScope,
    inputSchema: listWorkspacesInputSchema,
    outputSchema: listOutputSchema(
      "The normalized workspace list returned by Typeform.",
      "The workspaces returned for this page.",
      workspaceSchema,
    ),
  }),
  defineProviderAction(service, {
    name: "get_workspace",
    operationType: "read",
    description: "Get one Typeform workspace by workspace ID.",
    requiredScopes: workspacesReadScope,
    inputSchema: getWorkspaceInputSchema,
    outputSchema: s.object("The normalized single-workspace response returned by Typeform.", {
      workspace: workspaceSchema,
    }),
  }),
];
