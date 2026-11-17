import { prisma } from "../apps/api/src/db";

export async function seed(rows: any[]) {
  for (const r of rows) {
    await prisma.load.create({ data: r });
  }
}
