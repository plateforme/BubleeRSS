// Lint plat, sans plugin : les règles recommandées, et ce que le projet fait
// déjà — modules ES, deux espaces, apostrophes simples, point-virgule.
import js from '@eslint/js';
import globals from 'globals';

const commun = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'prefer-const': 'error',
  'no-var': 'error',
  eqeqeq: ['error', 'always'],
  quotes: ['error', 'single', { avoidEscape: true }],
  semi: ['error', 'always'],
  indent: ['error', 2, { SwitchCase: 1, flatTernaryExpressions: true, ignoredNodes: ['ConditionalExpression', 'TemplateLiteral *'] }]
};

export default [
  { ignores: ['node_modules/', 'data/', 'temp/', 'public/fonts/', 'docs/'] },
  {
    files: ['server/**/*.js', 'scripts/**/*.mjs', 'test/**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: commun
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
    rules: commun
  },
  {
    /* Le test de fumée vit des deux côtés : il tourne dans Node, mais le
       contenu de ses `page.evaluate()` s'exécute dans le navigateur. */
    files: ['test/fumee.mjs'],
    languageOptions: {
      ecmaVersion: 2024, sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    },
    rules: commun
  },
  {
    // Le service worker a ses propres globales : ni `window`, ni `document`.
    files: ['public/sw.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.serviceworker } },
    rules: commun
  }
];
