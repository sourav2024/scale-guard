import { Worker } from "bullmq";
import { prisma } from "../db";

export function startWorkers() {
  new Worker<{ id: number }>("webhooks", async (job) => {
    await prisma.order.update({ where: { id: job.data.id }, data: {} });
  }, { concurrency: 10 });
  new Worker<{ id: number }>("emails", async (job) => {
    await prisma.customer.findUnique({ where: { id: job.data.id } });
  }, { concurrency: 10 });
  new Worker("documents", async () => {}, { concurrency: 5 });
}
