# Zod v4 Internal API Changes for Custom Schema Converters

## The Insight

When you have custom code that introspects Zod's `_def` internals (like our `zodTypeToJsonSchema` in `tools/index.ts` and `standalone-server.ts`), Zod v4 silently renames several `_def` properties without compile-time errors because `_def` is typed as `any`. The code compiles fine but produces wrong output at runtime — accessing a renamed property returns `undefined` and falls through to a default, giving plausible-but-wrong results (e.g., arrays reporting item type as `string` instead of `number`).

## Why This Matters

This is a **silent runtime regression**, not a compile-time error. Tests catch it only if they assert on specific schema conversion output. Without those tests, tools would register with wrong JSON schemas and agents would send malformed arguments.

## Recognition Pattern

- Upgrading Zod major version (v3→v4, or any future major)
- Codebase has custom `zodTypeToJsonSchema` or similar introspection code
- Tests pass `tsc --noEmit` but fail on schema-related assertions
- Tool arguments arrive as wrong types at runtime

## The Approach

After any Zod major upgrade, verify `_def` property names by inspecting actual instances:

```typescript
// Quick check in node REPL:
const { z } = require('zod');
console.log(Object.keys(z.array(z.number())._def));  // v3: ['type'] → v4: ['type','element']
console.log(Object.keys(z.enum(['a','b'])._def));     // v3: ['values'] → v4: ['type','entries']
```

### Known v3→v4 `_def` changes (discovered in this codebase):

| Zod Type | v3 `_def` property | v4 `_def` property | What it holds |
|----------|-------------------|-------------------|---------------|
| `ZodArray` | `_def.type` | `_def.element` | The inner element schema (`_def.type` now returns the string `"array"`) |
| `ZodEnum` | `_def.values` (tuple) | `_def.entries` (record) | Enum members — use `Object.keys()` on v4 |
| `ZodDefault` | `_def.defaultValue()` (function) | `_def.defaultValue` (value) | Default value — no longer a thunk |
| `ZodType` | `.description` (property) | `.description` (getter) | Description string |
| Parse errors | `.error.errors` | `.error.issues` | Validation error array |

### Other v4 type-level changes:

- `ZodEnum<['a','b']>` (tuple) → `ZodEnum<{a:'a', b:'b'}>` (record) — breaks explicit generic annotations
- `z.record(z.unknown())` → `z.record(z.string(), z.unknown())` — key type now required
