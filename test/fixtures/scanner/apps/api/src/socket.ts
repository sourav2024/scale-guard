import { prisma } from "./db";

export function wire(io: any) {
  io.on("connection", (socket: any) => {
    socket.on("subscribe", async (loadId: number) => {
      const load = await prisma.load.findUnique({ where: { id: loadId } });
      socket.join(`load:${load.id}`);
    });
  });
}
