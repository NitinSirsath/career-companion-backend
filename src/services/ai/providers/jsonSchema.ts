import { z } from 'zod';

type Node = { [key: string]: unknown };

// Keywords strict structured-output dialects accept. Anything else Zod emits (for example
// minimum/maximum) is dropped here and still enforced by the contract's Zod validation.
const STRICT_KEPT = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'description',
  'items',
  'anyOf',
]);

function nullable(prop: Node): Node {
  if (Array.isArray(prop.type) && prop.type.includes('null')) return prop;
  // A fixed list of values that may be empty is "one of the list, or null": Anthropic refuses a
  // type list next to an enum ("Enum value does not match declared type").
  if (Array.isArray(prop.enum)) return { anyOf: [prop, { type: 'null' }] };
  if (Array.isArray(prop.type)) return { ...prop, type: [...prop.type, 'null'] };
  if (typeof prop.type === 'string') return { ...prop, type: [prop.type, 'null'] };
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
    for (const name of Object.keys(properties))
      if (!required.has(name)) properties[name] = nullable(properties[name]);
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

const strictSchemas = new WeakMap<z.ZodType, Node>();
const contractSchemas = new WeakMap<z.ZodType, Node>();
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

/** The contract's own JSON Schema, with the bounds the strict dialect drops. */
function contractSchema(schema: z.ZodType): Node {
  let json = contractSchemas.get(schema);
  if (!json) {
    json = z.toJSONSchema(schema) as Node;
    contractSchemas.set(schema, json);
  }
  return json;
}

/** Top-level keys the contract schema allows to be absent. */
export function optionalKeys(schema: z.ZodType): string[] {
  let keys = optional.get(schema);
  if (!keys) {
    const json = contractSchema(schema);
    const required = new Set((json.required as string[] | undefined) ?? []);
    keys = Object.keys((json.properties as Node | undefined) ?? {}).filter(
      (name) => !required.has(name),
    );
    optional.set(schema, keys);
  }
  return keys;
}

/** How far past a contract bound a number may land and still be a rounding error. */
const ROUNDING_ERROR = 1e-9;

/** The node itself, or its anyOf branch, that describes a value of this kind. */
function branchFor(node: Node, matches: (candidate: Node) => boolean): Node | undefined {
  if (matches(node)) return node;
  return Array.isArray(node.anyOf) ? (node.anyOf as Node[]).find(matches) : undefined;
}

function snapNumber(value: number, node: Node): number {
  const { minimum, maximum } = branchFor(node, (n) => n.type === 'number') ?? {};
  if (typeof maximum === 'number' && value > maximum && value - maximum <= ROUNDING_ERROR)
    return maximum;
  if (typeof minimum === 'number' && value < minimum && minimum - value <= ROUNDING_ERROR)
    return minimum;
  return value;
}

/**
 * A number a rounding error past a contract bound is the bound: a model may write
 * 1.0000000000000002 for full confidence, because the strict dialect does not send the bounds.
 * Anything further out is left for the contract's validation to refuse.
 */
function snapToBounds(value: unknown, node: Node | undefined): unknown {
  if (!node) return value;
  if (typeof value === 'number') return snapNumber(value, node);
  if (Array.isArray(value)) {
    const items = branchFor(node, (n) => n.type === 'array')?.items as Node | undefined;
    return items ? value.map((item) => snapToBounds(item, items)) : value;
  }
  if (value === null || typeof value !== 'object') return value;
  const properties = branchFor(node, (n) => n.type === 'object')?.properties as
    Record<string, Node> | undefined;
  if (!properties) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, snapToBounds(item, properties[key])]),
  );
}

/**
 * Undoes what the strict dialect changes, so the unchanged Zod schema (and contract version)
 * validates the answer: a null in a key the contract allows to be absent becomes absent, and a
 * number a rounding error past a contract bound becomes the bound.
 */
export function fromStrictDialect(data: unknown, schema: z.ZodType): unknown {
  const snapped = snapToBounds(data, contractSchema(schema));
  if (!snapped || typeof snapped !== 'object' || Array.isArray(snapped)) return snapped;
  const keys = optionalKeys(schema);
  return Object.fromEntries(
    Object.entries(snapped).filter(([key, value]) => !(value === null && keys.includes(key))),
  );
}
