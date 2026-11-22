/** Jest configuration for CLI unit tests.
 *  Skips the global setupTests.ts (which connects to MySQL/Redis)
 *  since CLI tests mock the database layer entirely.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/cli/**/*.test.ts'],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  // No setupFilesAfterEnv — CLI tests mock everything, no real DB needed
  collectCoverage: false,
  verbose: true,
  silent: false,
  maxWorkers: 1,
};
