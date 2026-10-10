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
    rules: {
      // Guidance: warnings only, never fail CI.
      'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
      complexity: ['warn', 15],
      'max-depth': ['warn', 3],
      'max-params': ['warn', 4],
      // Standards: fail CI. Old violations are listed in eslint-suppressions.json.
      'no-nested-ternary': 'error',
      'no-console': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read environment variables only in src/utils/config.ts.',
        },
      ],
    },
  },
  {
    files: ['src/routes/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/db/prisma'],
              message: 'Routes call services; they do not query the database.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/services/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/jobs/*'],
              message: 'Queue work through src/services/enqueue.ts, not job files.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/tests/**', 'src/**/*.test.ts', 'src/eval/**'],
    rules: {
      'max-lines': ['warn', { max: 800, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': 'off',
      complexity: 'off',
      'no-console': 'off',
      'no-restricted-properties': 'off',
    },
  },
  { files: ['src/utils/config.ts'], rules: { 'no-restricted-properties': 'off' } },
  { files: ['src/utils/log.ts'], rules: { 'no-console': 'off' } },
];
