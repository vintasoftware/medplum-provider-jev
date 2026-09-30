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
    // Playwright fixtures take a `use` callback and type auto fixtures as `void`.
    files: ['e2e/**'],
    rules: { 'react-hooks/rules-of-hooks': 'off', '@typescript-eslint/no-invalid-void-type': 'off' },
  }
);
