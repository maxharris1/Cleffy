import { z } from 'zod';

/**
 * The app's only entry point to zod — import `z` from here, never from 'zod'
 * (eslint enforces it).
 *
 * jitless: zod 4 compiles object parsers with `new Function`, after probing
 * whether it may with a `new Function('')` inside a try/catch. The production
 * CSP (vercel.json) has no 'unsafe-eval', so the probe throws — and although
 * zod swallows the error, the browser still reports a securitypolicyviolation
 * for it, on every page that parses a schema. A real violation would then hide
 * in that noise. The interpreted parser is plenty fast for what we validate.
 *
 * Configured here rather than in main.tsx so it holds in every bundle that
 * parses — this module is imported wherever a schema is defined — and so zod
 * stays out of the entry chunk.
 */
z.config({ jitless: true });

export { z };
