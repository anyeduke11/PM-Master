// 数据导出域路由（R5.3 C1）：Markdown 人读汇总 / JSON 全库包（附件下载）
import { exportJSON, exportMarkdown } from '../export.mjs';

export function register(app) {
  app.get('/api/v2/export/markdown', async (req, reply) => {
    const { markdown } = exportMarkdown();
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="pm-master-export-${new Date().toISOString().slice(0, 10)}.md"`);
    return markdown;
  });
  app.get('/api/v2/export/json', async (req, reply) => {
    reply.header('Content-Disposition', `attachment; filename="pm-master-export-${new Date().toISOString().slice(0, 10)}.json"`);
    // R6.5 C3：?tables=a,b 白名单过滤（exportJSON 内校验，未知表 400）
    return exportJSON(req.query?.tables != null ? { tables: req.query.tables } : {});
  });
}