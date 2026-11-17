import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";

export const prisma = new PrismaClient({ transactionOptions: { maxWait: 5000, timeout: 10000 } }).$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const result = await query(args);
        if (operation.startsWith("create")) await auditClient.auditLog.create({ data: { model } });
        return result;
      },
    },
  },
});

export const geoPool = new Pool({ max: Number(process.env.GEO_POOL_MAX ?? 10) });

export interface DbOptions {
  connectionLimit: number | null;
}
