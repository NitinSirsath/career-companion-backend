import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { files: ['**/*.{js,mjs,cjs,ts}'] },
  { languageOptions: { globals: globals.node } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  // Prettier adds every semicolon and owns line breaks, so this rule would only flag its output.
  { rules: { 'no-unexpected-multiline': 'off' } },
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['src/utils/log.ts', 'src/tests/**', 'src/**/*.test.ts', 'src/eval/**'],
    rules: { 'no-console': 'off' },
  },
];
