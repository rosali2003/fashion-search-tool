/**
 * Convert a permissive JSON Schema into one OpenAI strict mode accepts.
 *
 * Strict mode is the reason to use OpenAI here at all: it enforces the schema by
 * constrained decoding, so an enum value outside the controlled vocabulary is
 * impossible rather than merely discouraged. This codebase has 24 `coerce()` call
 * sites and drops out-of-vocabulary values silently, so turning that soft
 * guarantee into a hard one removes a whole class of quiet data loss.
 *
 * Strict mode imposes three rules the schemas in extract.ts / vision.ts / expand.ts
 * do not naturally satisfy:
 *
 *   1. every object must set `additionalProperties: false`
 *   2. every property must appear in `required`
 *   3. consequently there is no way to express "optional"
 *
 * Rule 3 is the awkward one, because "omit anything you are unsure of" is
 * load-bearing in the extraction prompts — a guessed neckline is worse than a
 * missing one. The standard encoding is a null union: the property is required,
 * and the model returns `null` to mean absent. Every sanitizer already treats
 * null and missing identically (`coerce` returns null for both), so nothing
 * downstream changes.
 */

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Widen a property's type to allow null, including inside an enum. */
function nullable(prop: Json): Json {
  const out: Json = { ...prop }

  const t = out.type
  if (typeof t === 'string') {
    out.type = t === 'null' ? t : [t, 'null']
  } else if (Array.isArray(t)) {
    out.type = t.includes('null') ? t : [...t, 'null']
  }

  // An enum must list null explicitly, or constrained decoding has no legal way
  // to emit the absent case.
  if (Array.isArray(out.enum) && !out.enum.includes(null)) {
    out.enum = [...out.enum, null]
  }
  return out
}

/**
 * Recursively rewrite a schema for strict mode.
 *
 * Arrays are deliberately NOT made nullable: an empty array already means
 * "nothing found", so allowing null as well would give the model two encodings
 * for one state and the sanitizers would have to handle both.
 */
export function toStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStrictSchema)
  if (!isObject(schema)) return schema

  const out: Json = { ...schema }

  if (out.type === 'array' && out.items) {
    out.items = toStrictSchema(out.items)
    return out
  }

  if (out.type === 'object' && isObject(out.properties)) {
    const originallyRequired = new Set(
      Array.isArray(out.required) ? (out.required as string[]) : [],
    )
    const props: Json = {}

    for (const [key, raw] of Object.entries(out.properties)) {
      const child = toStrictSchema(raw)
      if (!isObject(child)) {
        props[key] = child
        continue
      }
      // Arrays keep empty-array-as-absent; everything else gains a null union.
      const isArrayProp = child.type === 'array'
      props[key] =
        originallyRequired.has(key) || isArrayProp ? child : nullable(child)
    }

    out.properties = props
    out.required = Object.keys(props)
    out.additionalProperties = false
  }

  return out
}
