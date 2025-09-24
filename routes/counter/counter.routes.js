import { Router } from "express";
import { CounterController } from "../../controllers/counter/counter.controller.js";

const counterRouter = Router();
// CRUD - Create, Read, Update, Delete
// Create - POST
// Read - GET
// Update - PUT/PATCH
// Delete - DELETE
counterRouter.put('/increment', CounterController.incrementCounter);
counterRouter.get('/counter', CounterController.getCounter);

export { counterRouter };