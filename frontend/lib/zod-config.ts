import { z } from "zod";

/**
 * Zod compiles object parsers with `new Function` when it can, and probes for that with `Function("")`. Under the
 * strict Content-Security-Policy (no `'unsafe-eval'`, see `lib/csp.ts`) the probe is caught, but the browser still
 * reports a violation. `jitless` skips the probe and uses the interpreter path. Import this module before any
 * module that builds zod schemas, so the setting is in place when the schemas are defined.
 */
z.config({ jitless: true });
