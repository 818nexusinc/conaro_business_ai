// Creates the demo businesses (or gives their logins new passwords) and prints the logins once.
//   npm run seed:demo             # uses DATABASE_URL (or the embedded database)
//   npm run seed:demo -- --remove # closes the demo businesses and disables their logins
// On a hosted deployment you can do the same from /setup (needs BAI_SETUP_KEY).
import { createContainer } from "../src/container.ts";
import { removeDemo, seedDemo } from "../src/demo.ts";

const c = await createContainer();
if (process.argv.includes("--remove")) {
  console.log(`Closed ${await removeDemo(c.db)} demo businesses; their logins are disabled.`);
} else {
  const r = await seedDemo(c.db, c.app.deps);
  console.log(`Created: ${r.created.join(", ") || "none"} · New passwords: ${r.reset.join(", ") || "none"}`);
  console.log("Demo logins (shown once; synthetic data, simulation only):");
  console.table(r.credentials);
}
await c.close();
