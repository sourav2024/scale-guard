import express from "express";
import { auth } from "./auth";
import { startWorkers } from "./workers";
import client from "prom-client";

const app = express();
// app.use(limiter)
app.use(auth);
app.get("/metrics", async (_req, res) => res.send(await client.register.metrics()));
if (process.env.NODE_APP_INSTANCE === "0") startWorkers();
app.listen(3000);
