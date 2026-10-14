// 飞书域路由（P2 读 + P3 写回；凭据未配置时明确降级）
import { feishuConfigured, exportDoc, readDoc, deleteDoc } from '../feishu.mjs';
import { badRequest } from '../errors.mjs';

export function register(app) {
  app.get('/api/v2/feishu/status', async () => {
    const configured = feishuConfigured();
    return { configured, mode: configured ? 'ready' : 'manual', note: configured ? '' : '在 server/.env 配置 FEISHU_APP_ID/SECRET 后启用拉取；当前为手动粘贴模式' };
  });
  // 周报/报告写回飞书云文档：body {title, markdown}；未配置时返回可识别错误（前端降级下载）
  app.post('/api/v2/feishu/export-doc', async (req, reply) => {
    const { title, markdown } = req.body ?? {};
    if (!markdown) throw badRequest('markdown 必填');
    try {
      return await exportDoc({ title, markdown });
    } catch (e) {
      if (e.code === 'NOT_CONFIGURED') return reply.code(400).send({ code: 'NOT_CONFIGURED', message: e.message });
      throw e;
    }
  });
  app.post('/api/v2/feishu/read', async (req) => readDoc(req.body?.ref));
  // 删除飞书云文档（移入回收站；应用需 drive:drive 权限）：项目硬规则=删除双确认（confirm 必须等于 ref）
  app.post('/api/v2/feishu/delete', async (req, reply) => {
    const { ref, confirm } = req.body ?? {};
    if (!ref) throw badRequest('ref 必填');
    if (String(confirm ?? '') !== String(ref)) throw badRequest('删除需二次确认：confirm 必须等于 ref');
    try {
      return await deleteDoc(ref);
    } catch (e) {
      if (e.code === 'NOT_CONFIGURED') return reply.code(400).send({ code: 'NOT_CONFIGURED', message: e.message });
      if (e.code === 'BAD_REF') throw badRequest(e.message);
      throw e;
    }
  });
}