export class PrismaClient {
  constructor() {
    this.ticket = { findMany: async () => [] };
    this.businessHour = { findMany: async () => [] };
    this.appSettings = { findUnique: async () => null, findMany: async () => [] };
  }
  async $disconnect() {}
}

// Minimal `Prisma` namespace for services that compose raw-SQL fragments
// (Prisma.join / Prisma.sql / Prisma.empty). Tests mock the prisma client
// that would EXECUTE these, so the fragments only need to be constructible.
class MockSql {
  constructor(strings, values) {
    this.strings = strings;
    this.values = values;
  }
}
export const Prisma = {
  sql: (strings, ...values) => new MockSql([...strings], values),
  join: (values, separator = ', ') => new MockSql(
    values.length ? ['', ...Array(values.length - 1).fill(separator), ''] : [''],
    [...values],
  ),
  raw: (value) => new MockSql([String(value)], []),
  empty: new MockSql([''], []),
};
