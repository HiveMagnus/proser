module.exports = {
  globalSetup: '<rootDir>/scripts/require-isolated-test-services.cjs',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\.(ts|tsx)$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }]
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  collectCoverage: true,
  coverageDirectory: '<rootDir>/coverage',
  // Use concise coverage summary in console; full details in lcov report
  coverageReporters: ['text-summary', 'lcov'],
  coverageThreshold: {
    global: {
      statements: 48,
      branches: 24,
      functions: 43,
      lines: 51
    }
  },
  // Keep Jest output minimal
  verbose: false,
  // Suppress console output from tests unless they fail
  silent: true,
  // Run tests serially by default to avoid shared resource contention (equivalent to --runInBand)
  maxWorkers: 1,
  // Load .env before tests so DATABASE_URL etc. are available
  setupFiles: ['dotenv/config'],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setupTests.ts'],
};
