import { z } from 'zod';

type Node = { [key: string]: unknown };

// Keywords strict structured-output dialects accept. Anything else Zod emits (for example
// minimum/maximum) is dropped here and still enforced by the contract's Zod validation.
const STRICT_KEPT = new Set(['type', 'properties', 'required', 'additionalProperties', 'enum', 'description', 'items', 'anyOf']);

function nullable(prop: Node): Node {
  const withNullEnum = Array.isArray(prop.enum) ? { enum: [...prop.enum, null] } : {};
  if (Array.isArray(prop.type))
    return prop.type.includes('null') ? prop : { ...prop, type: [...prop.type, 'null'], ...withNullEnum };
  if (typeof prop.type === 'string') return { ...prop, type: [prop.type, 'null'], ...withNullEnum };
  return { anyOf: [prop, { type: 'null' }] };
}

function strict(node: Node): Node {
  const out: Node = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties')
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, Node>).map(([name, child]) => [name, strict(child)]),
      );
    else if (key === 'items') out.items = strict(value as Node);
    else if (key === 'anyOf') out.anyOf = (value as Node[]).map(strict);
    else if (STRICT_KEPT.has(key)) out[key] = value;
  }
  if (out.type === 'object' && out.properties) {
    // Strict dialects require every key: an optional key is sent as nullable instead.
    const properties = out.properties as Record<string, Node>;
    const required = new Set((out.required as string[] | undefined) ?? []);
    for (const name of Object.keys(properties)) if (!required.has(name)) properties[name] = nullable(properties[name]);
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

const strictSchemas = new WeakMap<z.ZodType, Node>();
const optional = new WeakMap<z.ZodType, string[]>();

/**
 * The strict JSON Schema dialect (OpenAI strict json_schema; Anthropic structured output and tool
 * input), derived from a contract's Zod schema: every key required, optional keys nullable,
 * no additional properties. The Zod schema stays the single source of truth and the validator.
 */
export function strictJsonSchema(schema: z.ZodType): Node {
  let derived = strictSchemas.get(schema);
  if (!derived) {
    const json = z.toJSONSchema(schema, { target: 'draft-7' }) as Node;
    delete json.$schema;
    derived = strict(json);
    strictSchemas.set(schema, derived);
  }
  return derived;
}

/** Top-level keys the contract schema allows to be absent. */
export function optionalKeys(schema: z.ZodType): string[] {
  let keys = optional.get(schema);
  if (!keys) {
    const json = z.toJSONSchema(schema) as Node;
    const required = new Set((json.required as string[] | undefined) ?? []);
    keys = Object.keys((json.properties as Node | undefined) ?? {}).filter((name) => !required.has(name));
    optional.set(schema, keys);
  }
  return keys;
}

/**
 * Undoes the strict dialect's "optional as nullable": a null in a key the contract allows to be
 * absent becomes absent, so the unchanged Zod schema (and contract version) validates it.
 */
export function nullsToAbsent(data: unknown, schema: z.ZodType): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const keys = optionalKeys(schema);
  return Object.fromEntries(
    Object.entries(data as Node).filter(([key, value]) => !(value === null && keys.includes(key))),
  );
}
