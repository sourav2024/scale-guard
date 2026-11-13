import { prisma } from "./db";

export async function auth(req: any, res: any, next: any) {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(401).end();
  next();
}
