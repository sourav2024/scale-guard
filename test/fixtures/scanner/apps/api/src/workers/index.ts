import { Worker } from "bullmq";
import { processInvoices } from "./processors";
import { prisma } from "../db";

async function handleSync(job: { data: { id: number } }) {
  await prisma.load.update({ where: { id: job.data.id }, data: {} });
}

function noop() {}

export function startWorkers() {
  new Worker("invoices", processInvoices, { concurrency: 5 });
  new Worker("sync", async (job) => handleSync(job), { concurrency: 3 });
  new Worker("noop", noop, { concurrency: 2 });
}
