import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // Gate de release (RNF4): parser y mapeador ≥ 70%.
      include: ['src/parser/**', 'src/mapper/**'],
      thresholds: { statements: 70, branches: 70, functions: 70, lines: 70 },
    },
  },
});
