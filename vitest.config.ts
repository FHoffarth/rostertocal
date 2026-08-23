import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // The forks pool fails to hand-shake in this sandboxed Windows shell.
    pool: 'threads',
    include: ['src/tests/**/*.test.ts'],
  },
});
