const js = require('@eslint/js');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

const sharedRules = {
  ...js.configs.recommended.rules,
  ...tsPlugin.configs.recommended.rules,
  '@typescript-eslint/no-unused-vars': [
    'warn',
    {
      argsIgnorePattern: '^_',
    },
  ],
  '@typescript-eslint/no-explicit-any': 'warn',
  'no-console': [
    'warn',
    {
      allow: ['warn', 'error'],
    },
  ],
  'prefer-const': 'warn',
  'no-var': 'warn',
};

module.exports = [
  {
    ignores: ['dist', 'out', 'release', 'node_modules', 'public'],
  },
  {
    files: ['src/**/*.ts', 'src/__tests__/**/*.ts'],
    ignores: ['src/renderer/**'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        NodeJS: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        require: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        jest: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: sharedRules,
  },
  {
    // Browser code: TypeScript checks names, so no-undef would only misfire on DOM types.
    files: ['src/renderer/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: './tsconfig.renderer.json',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...sharedRules,
      'no-undef': 'off',
    },
  },
];
