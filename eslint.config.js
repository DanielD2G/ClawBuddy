const tsParser = require('@typescript-eslint/parser')
const tsPlugin = require('@typescript-eslint/eslint-plugin')

const reactHooksPlugin = {
  rules: {
    'exhaustive-deps': {
      meta: {
        type: 'suggestion',
        schema: [],
      },
      create() {
        return {}
      },
    },
  },
}

module.exports = [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**'],
  },
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
]
