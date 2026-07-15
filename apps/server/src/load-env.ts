import { bootstrapRuntimeCredentialsSync } from "@openagentpack/sdk";

// Same bootstrap as playground/CLI: `.env` first, then ~/.agents/config.json wins.
bootstrapRuntimeCredentialsSync();
