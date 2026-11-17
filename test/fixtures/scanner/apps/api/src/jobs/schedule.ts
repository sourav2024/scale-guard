import cronJob from "node-cron";
import { Queue } from "bullmq";

const queue = new Queue("reports");

export function scheduleAll() {
  cronJob.schedule("*/5 * * * *", () => refreshTotals());
  queue.upsertJobScheduler("nightly", { pattern: "0 2 * * *" });
}
