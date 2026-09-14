import type { JsonSchema } from "./core/types.ts";

interface OutputField {
  path: string;
  type: string;
  description?: string;
  count?: number;
  dynamic?: boolean;
}

export interface OutputFieldOverview {
  fields: OutputField[];
  hasMore: boolean;
}

interface SchemaEntry {
  schema: JsonSchema;
  path: string;
  depth: number;
}

interface ValueEntry {
  value: unknown;
  path: string;
  depth: number;
}

const maxFields = 100;
const maxVisits = 1_000;
const maxDepth = 12;

/** Describe only the chosen Action's schema, without provider-specific defaults. */
export function describeOutputSchema(root: JsonSchema, prefix = ""): OutputFieldOverview {
  const queue: SchemaEntry[] = [{ schema: root, path: "$", depth: 0 }];
  const fields = new Map<string, OutputField>();
  let hasMore = false;
  let visits = 0;
  while (queue.length > 0 && visits++ < maxVisits) {
    const entry = queue.shift()!;
    const schema = resolveLocalRef(root, entry.schema);
    if (!schema || entry.depth > maxDepth || entry.path.length > 512) {
      hasMore = true;
      continue;
    }
    if (!relevantPath(entry.path, prefix)) continue;
    const type = schemaType(schema);
    if (prefix === "" || prefix === "$" || pathContains(prefix, entry.path)) {
      if (fields.size >= maxFields && !fields.has(entry.path)) {
        hasMore = true;
        break;
      }
      const previous = fields.get(entry.path);
      fields.set(entry.path, {
        path: entry.path,
        type: previous ? [...new Set([...previous.type.split(" | "), type])].join(" | ") : type,
        ...(typeof schema.description === "string" ? { description: schema.description.slice(0, 160) } : {}),
        ...(type === "object" && (schema.additionalProperties !== false || !schema.properties)
          ? { dynamic: true }
          : {}),
      });
    }
    const properties = asSchema(schema.properties);
    for (const [key, child] of Object.entries(properties ?? {})) {
      if (!asSchema(child)) continue;
      if (
        !enqueueSchema(queue, {
          schema: child as JsonSchema,
          path: childPath(entry.path, key),
          depth: entry.depth + 1,
        })
      ) {
        hasMore = true;
        break;
      }
    }
    const items = asSchema(schema.items);
    if (items && !enqueueSchema(queue, { schema: items, path: arrayPath(entry.path), depth: entry.depth + 1 })) {
      hasMore = true;
    }
    for (const keyword of ["anyOf", "oneOf", "allOf"]) {
      const variants = schema[keyword];
      if (!Array.isArray(variants)) continue;
      for (const variant of variants) {
        if (!asSchema(variant)) continue;
        if (!enqueueSchema(queue, { schema: variant, path: entry.path, depth: entry.depth + 1 })) {
          hasMore = true;
          break;
        }
      }
    }
  }
  return { fields: [...fields.values()], hasMore: hasMore || queue.length > 0 };
}

/** Discover actual field paths for outputs with incomplete or dynamic schemas. */
export function describeOutputValue(value: unknown): OutputFieldOverview {
  const queue: ValueEntry[] = [{ value, path: "$", depth: 0 }];
  const fields = new Map<string, OutputField>();
  let visits = 0;
  let hasMore = false;
  while (queue.length > 0 && visits++ < maxVisits) {
    const entry = queue.shift()!;
    if (entry.depth > maxDepth || entry.path.length > 512) {
      hasMore = true;
      continue;
    }
    if (!fields.has(entry.path) && fields.size >= maxFields) {
      hasMore = true;
      break;
    }
    const type = entry.value === null ? "null" : Array.isArray(entry.value) ? "array" : typeof entry.value;
    const previous = fields.get(entry.path);
    fields.set(entry.path, {
      path: entry.path,
      type: previous ? [...new Set([...previous.type.split(" | "), type])].join(" | ") : type,
      ...(Array.isArray(entry.value) ? { count: entry.value.length } : {}),
    });
    if (Array.isArray(entry.value)) {
      for (const item of entry.value.slice(0, 3)) {
        queue.push({ value: item, path: arrayPath(entry.path), depth: entry.depth + 1 });
      }
      if (entry.value.length > 3) hasMore = true;
    } else if (entry.value && typeof entry.value === "object") {
      for (const [key, child] of Object.entries(entry.value)) {
        if (queue.length >= maxVisits) {
          hasMore = true;
          break;
        }
        queue.push({ value: child, path: childPath(entry.path, key), depth: entry.depth + 1 });
      }
    }
  }
  return { fields: [...fields.values()], hasMore: hasMore || queue.length > 0 };
}

/** Return small, complete values only; never cut a JSON object or string midway. */
export function completeOutputExamples(value: unknown): Array<{ path: string; value: unknown }> {
  const examples: Array<{ path: string; value: unknown }> = [];
  const queue: ValueEntry[] = [{ value, path: "$", depth: 0 }];
  let visits = 0;
  while (queue.length > 0 && examples.length < 3 && visits++ < 100) {
    const entry = queue.shift()!;
    if (entry.path.length > 512) continue;
    const serialized = JSON.stringify(entry.value);
    if (serialized !== undefined && serialized.length <= 512) {
      examples.push({ path: entry.path, value: entry.value });
    } else if (entry.depth < 4 && Array.isArray(entry.value)) {
      for (const item of entry.value.slice(0, 2))
        queue.push({ value: item, path: arrayPath(entry.path), depth: entry.depth + 1 });
    } else if (entry.depth < 4 && entry.value && typeof entry.value === "object") {
      for (const [key, child] of Object.entries(entry.value).slice(0, 20)) {
        queue.push({ value: child, path: childPath(entry.path, key), depth: entry.depth + 1 });
      }
    }
  }
  return examples;
}

function schemaType(schema: JsonSchema): string {
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (typeof schema.type === "string") return schema.type;
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return "unknown";
}

function resolveLocalRef(root: JsonSchema, schema: JsonSchema): JsonSchema | undefined {
  const seen = new Set<string>();
  while (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (!ref.startsWith("#/") || seen.has(ref)) return undefined;
    seen.add(ref);
    let target: unknown = root;
    for (const part of ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      const object = asSchema(target);
      target = object && Object.hasOwn(object, key) ? object[key] : undefined;
    }
    const resolved = asSchema(target);
    if (!resolved) return undefined;
    schema = resolved;
  }
  return schema;
}

function asSchema(value: unknown): JsonSchema | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonSchema) : undefined;
}

function childPath(parent: string, key: string): string {
  if (key === "$" || /[.[\]\s"\\]/u.test(key) || key === "") {
    return `${parent === "$" ? "" : parent}[${JSON.stringify(key)}]`;
  }
  return parent === "$" ? key : `${parent}.${key}`;
}

function arrayPath(parent: string): string {
  return parent === "$" ? "[]" : `${parent}[]`;
}

function relevantPath(path: string, prefix: string): boolean {
  if (prefix === "" || prefix === "$") return true;
  return pathContains(path, prefix) || pathContains(prefix, path);
}

function pathContains(parent: string, child: string): boolean {
  if (parent === "$") return true;
  if (!child.startsWith(parent)) return false;
  const boundary = child[parent.length];
  return boundary === undefined || boundary === "." || boundary === "[";
}

function enqueueSchema(queue: SchemaEntry[], entry: SchemaEntry): boolean {
  if (queue.length >= maxVisits) return false;
  queue.push(entry);
  return true;
}
