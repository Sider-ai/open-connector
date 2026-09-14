/** A validated projection of JSON output, independent of any provider. */
export interface ResultFieldSelection {
  project(value: unknown): unknown;
}

interface SelectionNode {
  fields: Set<string>;
  selected: boolean;
  properties: Map<string, SelectionNode>;
  items?: SelectionNode;
}

export class ResultFieldsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultFieldsError";
  }
}

/** Validate selectors before provider execution; [] selects every array item. */
export function createResultFieldSelection(fields: readonly string[]): ResultFieldSelection {
  if (fields.length === 0 || fields.length > 64) {
    throw new ResultFieldsError("Choose between 1 and 64 resultFields.");
  }
  const root = createNode();
  for (const field of fields) {
    const tokens = parsePath(field);
    let node = root;
    node.fields.add(field);
    for (const token of tokens) {
      if (token === null) {
        node.items ??= createNode();
        node = node.items;
      } else {
        let child = node.properties.get(token);
        if (!child) {
          child = createNode();
          node.properties.set(token, child);
        }
        node = child;
      }
      node.fields.add(field);
    }
    node.selected = true;
  }
  return {
    project(value) {
      const matched = new Set<string>();
      const projected = projectNode(value, root, matched);
      const missing = [...root.fields].filter((field) => !matched.has(field));
      if (missing.length > 0) {
        throw new ResultFieldsError(`Fields not found in the returned output: ${missing.join(", ")}`);
      }
      return projected;
    },
  };
}

function createNode(): SelectionNode {
  return { fields: new Set(), selected: false, properties: new Map() };
}

function parsePath(path: string): Array<string | null> {
  if (path === "$") return [];
  if (path.length === 0 || path.length > 512)
    throw new ResultFieldsError("Result field paths must be 1–512 characters.");
  const tokens: Array<string | null> = [];
  const pattern = /(?:^|\.)([^.[\]]+)|\[\]|\[("(?:[^"\\]|\\.)*")\]/uy;
  let offset = 0;
  while (offset < path.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(path);
    if (!match || (offset === 0 && path.startsWith("."))) {
      throw new ResultFieldsError(`Invalid result field path: ${path}. Use dotted keys and [] for arrays.`);
    }
    offset = pattern.lastIndex;
    if (match[0] === "[]") {
      tokens.push(null);
      continue;
    }
    let key: string;
    try {
      key = match[1] ?? JSON.parse(match[2]!);
    } catch {
      throw new ResultFieldsError(`Invalid quoted result field key: ${path}.`);
    }
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new ResultFieldsError(`Unsupported result field key: ${key}.`);
    }
    tokens.push(key);
  }
  if (tokens.length > 16) throw new ResultFieldsError("Result field paths must not exceed 16 nesting levels.");
  return tokens;
}

function projectNode(value: unknown, node: SelectionNode, matched: Set<string>): unknown {
  if (node.selected || value === null || (Array.isArray(value) && value.length === 0 && node.items)) {
    for (const field of node.fields) matched.add(field);
    return value;
  }
  if (Array.isArray(value)) {
    return node.items ? value.map((item) => projectNode(item, node.items!, matched)) : [];
  }
  // A heterogeneous array can contain scalars where an object path was
  // requested. Keep its position without leaking the unselected scalar.
  if (typeof value !== "object") return null;
  const result: Record<string, unknown> = {};
  for (const [key, child] of node.properties) {
    if (Object.hasOwn(value, key)) {
      result[key] = projectNode((value as Record<string, unknown>)[key], child, matched);
    }
  }
  return result;
}
