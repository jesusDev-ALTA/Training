import { CounterModel } from "../../models/counter/counter.model.js";

export class CounterController{
    static async incrementCounter(req, res) {
        try {
            const newCount = await CounterModel.incrementCounter();
            res.status(200).json({ count: newCount });
        }catch (error) {
            res.status(500).json({ error: 'Internal Server Error' });
        }
    }
    static async getCounter(req, res) {
        try {
            const currentCount = await CounterModel.getCounter();
            res.status(200).json({ count: currentCount });
        }catch (error) {
            res.status(500).json({ error: 'Internal Server Error' });
        }   
    }
}