import * as AuthRouter from "./auth/auth.routes";
import * as SessionRouter from "./session/session.routes";
import * as DevicesRouter from "./devices/devices.routes";

import { Router } from "express";

export const router = Router();

router.use("/auth", AuthRouter.router);
router.use("/session", SessionRouter.router);
router.use("/devices", DevicesRouter.router);
