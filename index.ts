import { Router, type IRouter } from "express";
import chatRouter from "./chat";
import healthRouter from "./health";
import searchRouter from "./search";

const router: IRouter = Router();

router.use(chatRouter);
router.use(searchRouter);
router.use(healthRouter);

export default router;
