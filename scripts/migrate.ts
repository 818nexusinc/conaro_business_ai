// Applies pending migrations (also done automatically at start-up).
import { createContainer } from "../src/container.ts";
import { migrate } from "../src/shared/migrate.ts";

const c = await createContainer();
const ran = await migrate(c.db);
console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
await c.close();
