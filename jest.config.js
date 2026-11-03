/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    // jose is published as ES modules only; compile it for Jest. The path
    // patterns accept both / and \ so they also work on Windows.
    '[/\\\\]node_modules[/\\\\]jose[/\\\\].+\\.js$': [
      'ts-jest',
      { tsconfig: { allowJs: true }, diagnostics: false },
    ],
  },
  transformIgnorePatterns: ['[/\\\\]node_modules[/\\\\](?!jose[/\\\\])'],
};
