import { z } from 'zod';

// Side effect only, imported first by the web app (apps/web/src/main.tsx) so it runs before any
// schema is built. The SPA's Content-Security-Policy has no 'unsafe-eval' (Caddyfile), and zod
// probes for eval with new Function() when it builds an object schema. The probe is caught and zod
// falls back to its plain parser, but the browser still reports a CSP violation on every page
// load, which would bury a real one. jitless skips the probe and the eval-compiled fast path the
// CSP blocks anyway. The api never imports this and keeps the fast path.
z.config({ jitless: true });
