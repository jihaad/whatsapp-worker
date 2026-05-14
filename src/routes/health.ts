import { Router } from 'express';

const router = Router();

router.get('/', (_, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

export default router;
