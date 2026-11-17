import Redis from "ioredis";

export const redis = new Redis(process.env.REDIS_URL);
export const safeRedis = new Redis(process.env.REDIS_URL, { commandTimeout: 500 });

export async function clearUser(id: string) {
  const keys = await redis.keys(`user:${id}:*`);
  if (keys.length) await redis.del(...keys);
}
