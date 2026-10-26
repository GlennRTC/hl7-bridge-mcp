import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist'] },
  ...tseslint.configs.recommended,
  // Shipped code goes through store scanners that count single-letter names as obfuscation.
  { files: ['src/**/*.ts'], ignores: ['src/**/*.test.ts'], rules: { 'id-length': ['error', { min: 2, properties: 'never' }] } },
);
