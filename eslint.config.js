import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist', 'dev-dist', 'coverage', 'node_modules', 'services/omr-service/dist'] },
    {
        files: ['**/*.{ts,tsx}'],
        extends: [
            js.configs.recommended,
            ...tseslint.configs.recommended,
            reactHooks.configs.flat['recommended-latest'],
            reactRefresh.configs.vite,
        ],
        languageOptions: {
            ecmaVersion: 2022,
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
            '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
        },
    },
    {
        files: ['**/*.js', '**/*.mjs'],
        extends: [js.configs.recommended],
        languageOptions: {
            globals: {
                Buffer: 'readonly',
                console: 'readonly',
                process: 'readonly',
                URL: 'readonly',
                crypto: 'readonly',
                fetch: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                // Browser globals: E2E scripts embed page-context closures
                // (addInitScript / evaluate) that run inside Chromium.
                window: 'readonly',
                document: 'readonly',
                localStorage: 'readonly',
                Blob: 'readonly',
                WebSocket: 'readonly',
                navigator: 'readonly',
                performance: 'readonly',
            },
        },
    },
    prettier,
);
