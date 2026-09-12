import { config } from "dotenv";

// Single Environment Loader: load .env into process.env before any configuration is read.
// Application code (src/ollama/model.ts and everything downstream) still reads ONLY process.env.
// This file is the only place that knows about .env; .env is purely a config-injection layer.
config();
