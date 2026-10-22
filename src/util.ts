export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Own property only, so a field named "constructor" never reads the prototype. */
export function own(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** Sets a key safely, including "__proto__". */
export function setProp(o: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Stable JSON text: object keys sorted, undefined members left out. Used for equality. Walks with
 * an explicit stack, so no nesting depth can overflow the call stack.
 */
export function canonical(v: unknown): string {
  const leaf = (x: unknown) => (x === undefined ? 'undefined' : JSON.stringify(x));
  type Frame = { v: unknown[] | Record<string, unknown>; keys: string[] | null; i: number; out: string[]; prefix: string };
  const frame = (x: unknown, prefix: string): Frame | null => {
    if (Array.isArray(x)) return { v: x, keys: null, i: 0, out: [], prefix };
    if (isPlainObject(x)) return { v: x, keys: Object.keys(x).filter((k) => x[k] !== undefined).sort(), i: 0, out: [], prefix };
    return null;
  };
  const first = frame(v, '');
  if (!first) return leaf(v);
  const stack = [first];
  for (;;) {
    const f = stack[stack.length - 1]!;
    const size = f.keys ? f.keys.length : (f.v as unknown[]).length;
    if (f.i < size) {
      const key = f.keys?.[f.i];
      const child = key === undefined ? (f.v as unknown[])[f.i] : (f.v as Record<string, unknown>)[key];
      const prefix = key === undefined ? '' : `${JSON.stringify(key)}:`;
      f.i++;
      const next = frame(child, prefix);
      if (next) stack.push(next);
      else f.out.push(prefix + leaf(child));
      continue;
    }
    stack.pop();
    const text = f.keys ? `{${f.out.join(',')}}` : `[${f.out.join(',')}]`;
    if (stack.length === 0) return text;
    stack[stack.length - 1]!.out.push(f.prefix + text);
  }
}

/** A language map: an object of language → text, `{ "en": "Status", "de": "Status" }`, with at least one language. */
export function isLangMap(v: unknown): v is Record<string, string> {
  return isPlainObject(v) && Object.values(v).every((x) => typeof x === 'string') && Object.keys(v).some((k) => !k.startsWith('$'));
}

/** The language entries of an object: keys not starting with `$` that hold text. Undefined when there are none. */
export function langEntries(v: unknown): Record<string, string> | undefined {
  if (!isPlainObject(v)) return undefined;
  const out: Record<string, string> = {};
  let found = false;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (!k.startsWith('$') && typeof x === 'string') {
      setProp(out, k, x);
      found = true;
    }
  }
  return found ? out : undefined;
}

/**
 * Picks a map's text for a language: the exact language ("de-CH"), its base ("de"), the
 * fallback language, then the map's first language. Keys starting with `$` are skipped.
 */
export function pickLang(map: Record<string, string>, language: string, fallback = 'en'): string {
  const keys = Object.keys(map).filter((k) => !k.startsWith('$') && typeof map[k] === 'string');
  const find = (lang: string) => {
    const want = lang.toLowerCase();
    return keys.find((k) => k.toLowerCase() === want) ?? keys.find((k) => k.toLowerCase() === want.split('-')[0]);
  };
  const key = find(language) ?? find(fallback) ?? keys[0];
  return key === undefined ? '' : map[key]!;
}

export function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** `primaryAddress` → "Primary Address", `phone_number` → "Phone Number". */
export function titleCase(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean);
  if (words.length === 0) return key;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function isEmpty(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    v === '' ||
    (Array.isArray(v) && v.length === 0) ||
    (isPlainObject(v) && Object.keys(v).length === 0)
  );
}

/** Field names used in an item label template: "{firstName} {lastName}" → ["firstName", "lastName"]. */
export function templateFields(template: string): string[] {
  return [...template.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!.trim());
}
