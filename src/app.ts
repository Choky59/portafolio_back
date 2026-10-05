import express from "express";
import * as ApiRoutes from "./startup/routes";
import * as Plugins from "./startup/plugins";

/**
 * Builds the Express app without connecting to Mongo or listening,
 * so tests can mount it with supertest.
 */
export function createApp(): express.Express {
  const app = express();

  // Needed for req.ip to reflect the real client IP behind a proxy (Heroku router),
  // otherwise per-IP rate limits apply to everyone at once.
  // Number of trusted hops (not `true`) so X-Forwarded-For can't be spoofed.
  app.set("trust proxy", parseInt(process.env.TRUST_PROXY ?? "1"));

  Plugins.security(app);
  ApiRoutes.startRoutes(app);
  Plugins.errorHandlers(app);

  return app;
}
