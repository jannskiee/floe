import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        // app/ is in for route handlers that import nothing from Next (the
        // config route). A page or a layout cannot run here: next/font resolves
        // to an empty shim outside next build.
        include: ['lib/**/*.test.ts', 'app/**/*.test.ts'],
    },
});
