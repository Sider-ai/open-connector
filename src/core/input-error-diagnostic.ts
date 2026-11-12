const inputErrorMessages = {
  path_is_directory: "The path resolves to a directory. Use the directory listing action.",
  path_not_directory: "The path does not resolve to a directory.",
  path_not_regular_file: "The path does not resolve to a regular file.",
  conflicting_aliases: "Alias fields must match when both are supplied.",
  invalid_workflow_run_id: "Provide a positive, safe integer workflow run ID.",
  file_revision_required: "Read the target file first and supply its current revision when updating.",
  file_content_required: "Provide file contents. Use an explicit empty string for an empty file.",
  invalid_file_content_type: "File contents must be strings when supplied.",
};

export type InputErrorCode = keyof typeof inputErrorMessages;

/** Resolve only code-owned messages so local diagnostics never retain rejected input values. */
export function inputErrorMessage(code: unknown): string | undefined {
  return typeof code === "string" && Object.hasOwn(inputErrorMessages, code)
    ? inputErrorMessages[code as InputErrorCode]
    : undefined;
}
