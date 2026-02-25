export class PrismaClient {
  constructor() {
    this.ticket = { findMany: async () => [] };
    this.businessHour = { findMany: async () => [] };
    this.appSettings = { findUnique: async () => null, findMany: async () => [] };
  }
  async $disconnect() {}
}
