export default {
  transform: {},
  testMatch: ['**/tests/**/*.test.js'],
  moduleNameMapper: {
    '^@prisma/client$': '<rootDir>/tests/__mocks__/prismaClient.js',
  },
};
