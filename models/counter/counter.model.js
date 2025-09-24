let counter = 0;
export class CounterModel{
    static async incrementCounter() {
        counter += 1;
        return counter;
    }
    static async getCounter() {
        return counter;
    }
}