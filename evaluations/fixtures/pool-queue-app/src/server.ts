import express from "express";
import { auth } from "./auth";
import { listOrders, customerReport, confirmOrder } from "./routes/orders";
import { startWorkers } from "./workers";

const app = express();
app.use(auth);
app.get("/orders", listOrders);
app.get("/reports/customers", customerReport);
app.post("/orders/:id/confirm", confirmOrder);
startWorkers();
app.listen(3000);
