// One agents' cycle for every business (marketplace sync first when linked), then exit.
import { createContainer } from "../src/container.ts";
import { businessAiCycle } from "../src/workflows.ts";

const c = await createContainer();
const r = await businessAiCycle(c.db, c.app.deps, c.marketplace ? { marketplace: c.marketplace } : {});
console.log(JSON.stringify(r, null, 2));
await c.close();
