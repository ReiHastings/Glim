import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'dist-perf', 'ios']),   // dist-perf: tests/perf build output
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // argsIgnorePattern mirrors varsIgnorePattern for component-valued props
      // (e.g. MenuItem's Icon): core ESLint has no jsx-uses-vars, so a
      // capitalized parameter rendered only as <Icon /> reads as unused.
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^[A-Z_]' }],
      // Message text must not itself contain U+2014 or the rule flags this file.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/\\u2014/]',
          message: 'Em dash (U+2014) is forbidden in Glim strings. Use hyphen, comma, or period.',
        },
        {
          selector: 'TemplateElement[value.raw=/\\u2014/]',
          message: 'Em dash (U+2014) is forbidden in Glim strings. Use hyphen, comma, or period.',
        },
      ],
      // React Compiler purity/immutability checks (new in react-hooks v7
      // recommended) flag ~21 pre-existing sites: decorative Math.random()
      // during render in Background/AmbientBugs, ref initializers, and the
      // documented ref-mirror pattern. All are deliberate or benign at
      // runtime. Warn (not off) so they stay visible in /verify; revisit
      // per eslint_config_notes.md if any is promoted back to error.
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      // HMR nicety, not correctness: settings files deliberately export
      // summary helpers alongside their component.
      'react-refresh/only-export-components': 'warn',
    },
  },
])
