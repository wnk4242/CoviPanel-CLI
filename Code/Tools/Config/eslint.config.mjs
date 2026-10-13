import js from '../../../Setups/node_modules/@eslint/js/src/index.js';
import globals from '../../../Setups/node_modules/globals/index.js';

export default [
  {
    ignores: ['Setups/node_modules/**', 'Setups/Browser Login/**'],
  },
  {
    files: ['Code/**/*.js', 'Code/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
];
