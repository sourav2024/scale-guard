import { prisma } from "../db";

export async function listOrders(req: any, res: any) {
  const page = Number(req.query.page ?? 0);
  if (req.query.sort === "firstShipment") {
    const all = await prisma.order.findMany({
      where: { tenantId: req.tenantId },
      include: { shipments: true },
    });
    const sorted = all.sort((a, b) => +a.shipments[0].shippedAt - +b.shipments[0].shippedAt);
    return res.json(sorted.slice(page * 50, page * 50 + 50));
  }
  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where: { tenantId: req.tenantId },
      include: { customer: true, items: true, shipments: true },
      skip: page * 50,
      take: 50,
    }),
    prisma.order.count({ where: { tenantId: req.tenantId } }),
  ]);
  res.json({ rows, total });
}

export async function customerReport(req: any, res: any) {
  const customers = await prisma.customer.findMany({ where: { tenantId: req.tenantId } });
  const out = [];
  for (const c of customers) {
    const orders = await prisma.order.count({ where: { customerId: c.id } });
    out.push({ id: c.id, orders });
  }
  res.json(out);
}

export async function confirmOrder(req: any, res: any) {
  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.update({ where: { id: req.params.id }, data: {} });
    await fetch("https://payments.example.com/capture", { method: "POST", body: JSON.stringify(order) });
    return order;
  }, { timeout: 30000 });
  res.json(result);
}
