import { Router } from 'express';
import { apiReference } from '@scalar/express-api-reference';
import { openApiSpec } from '../openapi';

const router = Router();

router.get('/openapi.json', (_req, res) => {
  res.json(openApiSpec);
});

router.use('/', apiReference({ content: openApiSpec }));

export default router;
