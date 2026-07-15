import "./load-env";
import { app } from "@/app";

const port = Number(process.env.PORT ?? 4000);
console.log(`server listening on :${port}`);

export default { port, fetch: app.fetch, idleTimeout: 0 };
