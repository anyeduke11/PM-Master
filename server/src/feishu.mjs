// P3+ 飞书写回（PRD 9.1 P3：周报回写云文档）
// 凭据门控：.env 配 FEISHU_APP_ID / FEISHU_APP_SECRET 即启用（自建应用需开通 docx:document 权限）
const BASE = 'https://open.feishu.cn/open-apis';

let tokenCache = { token: null, exp: 0 };

export function feishuConfigured() {
  return Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET);
}

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const res = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET }),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`飞书 token 获取失败: ${j.msg}`);
  tokenCache = { token: j.tenant_access_token, exp: Date.now() + (j.expire - 300) * 1000 };
  return tokenCache.token;
}

// markdown → docx blocks（标题/段落/列表/表格行转文本；demo 级保真）
function md2blocks(md) {
  const blocks = [];
  const textEl = (t) => ({ text_run: { content: t || ' ' } });
  for (const raw of String(md).split('\n')) {
    const line = raw.replace(/\*\*/g, '').trimEnd();
    if (!line.trim()) continue;
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      const lv = m[1].length;   // block_type: 3=heading1 4=heading2 5=heading3
      blocks.push({ block_type: 2 + lv, [`heading${lv}`]: { elements: [textEl(m[2])] } });
    } else if (/^\|/.test(line)) {
      blocks.push({ block_type: 2, text: { elements: [textEl(line.replace(/\|/g, ' ').trim())] } });
    } else {
      blocks.push({ block_type: 2, text: { elements: [textEl(line)] } });
    }
  }
  return blocks;
}

export async function exportDoc({ title, markdown }) {
  if (!feishuConfigured()) {
    const err = new Error('飞书未配置（server/.env 设置 FEISHU_APP_ID/FEISHU_APP_SECRET）');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const token = await getToken();

  // 1) 创建文档
  const create = await fetch(`${BASE}/docx/v1/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: title || 'PM-Master 导出' }),
  }).then((r) => r.json());
  if (create.code !== 0) throw new Error(`创建文档失败: ${create.msg}`);
  const docId = create.data.document.document_id;

  // 2) 分批写入块（每批 ≤50，docx API 限制）
  const blocks = md2blocks(markdown);
  for (let i = 0; i < blocks.length; i += 50) {
    const batch = blocks.slice(i, i + 50);
    const w = await fetch(`${BASE}/docx/v1/documents/${docId}/blocks/${docId}/children`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ children: batch, index: -1 }),
    }).then((r) => r.json());
    if (w.code !== 0) throw new Error(`写入内容失败: ${w.msg}`);
  }

  // 3) 设置链接分享=组织内可编辑（app 创建的文档用户默认无权限打开；失败不阻塞）
  try {
    await fetch(`${BASE}/drive/v1/permissions/${docId}/public?type=docx`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ extra: { link_share_entity: 'tenant_editable' } }),
    });
  } catch { /* 权限未开通时忽略，用户可手动申请访问 */ }

  return { document_id: docId, url: `https://feishu.cn/docx/${docId}`, blocks: blocks.length };
}
