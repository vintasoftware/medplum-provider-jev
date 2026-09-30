import { medplumEslintConfig } from '@medplum/eslint-config';
// eslint-disable-next-line import/no-unresolved -- Node resolves this package export; eslint-plugin-import does not.
import { defineConfig } from 'eslint/config';

export default defineConfig(
  medplumEslintConfig,
  {
    ignores: ['bot-dist/**'],
  },
  {
    // Upstream files keep their SPDX headers; files added by this demo carry none.
    rules: { 'header/header': 'off' },
  },
  {
    // The Bot, the scripts and the Playwright tests are not React code.
    files: ['bots/**', 'scripts/**', 'e2e/**'],
    rules: { 'react-hooks/rules-of-hooks': 'off', 'react-refresh/only-export-components': 'off' },
  },
  {
    // Playwright types auto fixtures as `void`.
    files: ['e2e/**'],
    rules: { '@typescript-eslint/no-invalid-void-type': 'off' },
  }
);
