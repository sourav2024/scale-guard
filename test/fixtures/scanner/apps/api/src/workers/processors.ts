import { prisma } from "../db";

export async function processInvoices(job: { data: { id: number } }) {
  await prisma.invoice.update({ where: { id: job.data.id }, data: { sent: true } });
}
