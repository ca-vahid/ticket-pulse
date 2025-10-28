import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function countUnmapped() {
  try {
    const count = await prisma.ticket.count({
      where: {
        assignedTechId: null,
        OR: [
          { firstAssignedAt: { not: null } },
          { status: { in: ['Closed', 'Resolved'] } },
        ],
      },
    });

    console.log(`Unmapped tickets: ${count}`);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

countUnmapped();
