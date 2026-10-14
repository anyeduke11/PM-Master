// 风险评估专项域路由（W4）
import {
  SCENARIOS, listRaProjects, createRaProject, raDetail, addAsset, addFinding,
  updateFinding, setRaPhase, raExtract, raReport,
} from '../ra.mjs';

export function register(app) {
  app.get('/api/v2/ra/scenarios', async () => SCENARIOS);
  app.get('/api/v2/ra/projects', async () => listRaProjects());
  app.post('/api/v2/ra/projects', async (req) => createRaProject(req.body ?? {}));
  app.get('/api/v2/ra/projects/:id', async (req) => raDetail(Number(req.params.id)));
  app.post('/api/v2/ra/projects/:id/phase', async (req) => setRaPhase(Number(req.params.id), req.body?.phase));
  app.post('/api/v2/ra/projects/:id/assets', async (req) => addAsset(Number(req.params.id), req.body ?? {}));
  app.post('/api/v2/ra/projects/:id/findings', async (req) => addFinding(Number(req.params.id), req.body ?? {}));
  app.post('/api/v2/ra/findings/:id', async (req) => updateFinding(Number(req.params.id), req.body ?? {}));
  app.post('/api/v2/ra/projects/:id/extract', async (req) => raExtract(Number(req.params.id), String(req.body?.text ?? '')));
  app.post('/api/v2/ra/projects/:id/report', async (req) => raReport(Number(req.params.id)));
}