import { prisma, geoPool } from "../db";

export class ReportController {
  constructor(private prisma: any) {}

  async perCarrier(req: any, res: any) {
    const limit = Number(req.query.limit ?? 20);
    const carriers = await this.prisma.carrier.findMany({ take: limit });
    const rows = await Promise.all(carriers.map((c: any) => prisma.load.findMany({ where: { carrierId: c.id } })));
    res.json(rows);
  }

  async nested(ids: number[][]) {
    for (const group of ids) {
      for (const id of group) {
        await this.prisma.load.findUnique({ where: { id } });
      }
    }
  }

  async raw(ids: number[]) {
    for (const id of ids) {
      await geoPool.query("select * from pings where load_id = $1", [id]);
    }
  }

  async backfill() {
    let cursor: number | undefined;
    while (true) {
      const batch = await prisma.load.findMany({ take: 500, cursor: cursor ? { id: cursor } : undefined, skip: cursor ? 1 : 0 });
      if (!batch.length) break;
      cursor = batch[batch.length - 1].id;
    }
  }

  async bounded(ids: number[]) {
    const a = await prisma.load.findMany({ where: { id: { in: ids } } });
    const b = await prisma.country.findMany({ orderBy: { name: "asc" } });
    // scale-guard-ignore: reviewed, tenant has < 50 loads by contract
    const c = await prisma.load.findMany({ where: { customerId: 1 } });
    const capped = Math.min(Number(req.query.size), 100);
    return [a, b, c, capped];
  }
}
