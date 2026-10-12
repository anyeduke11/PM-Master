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

// ================= R7.0 P5 飞书读入（数据流入管道） =================
// 解析引用：支持 /docx/<token>、/wiki/<token>、裸 token（wiki 需 get_node 换 obj_token）
export function parseDocRef(s) {
  const str = String(s ?? '').trim();
  let m = /\/(docx|wiki)\/([A-Za-z0-9_-]+)/.exec(str);
  if (m) return { kind: m[1], token: m[2] };
  if (/^[A-Za-z0-9_-]{10,}$/.test(str)) return { kind: 'docx', token: str };
  return null;
}

async function apiGet(path, token) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const txt = await res.text();
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error(`飞书 API ${path.split('?')[0]} 非 JSON 响应（HTTP ${res.status}，常见原因：权限未开通或端点错误）`); }
  if (j.code !== 0) throw new Error(`飞书 API ${path.split('?')[0]}: ${j.msg}`);
  return j.data;
}

// docx blocks → Markdown（demo 级保真：标题/正文/列表/表格行展平；读入目的是喂导入向导，非排版还原）
function blocks2md(items) {
  const textOf = (b) => (b.elements ?? []).map((e) => e.text_run?.content ?? '').join('');
  return items.map((b) => {
    const t = b.block_type;
    if (t >= 3 && t <= 11) return `${'#'.repeat(t - 2)} ${b[`heading${t - 2}`]?.elements?.map((e) => e.text_run?.content ?? '').join('') ?? ''}`;
    if (t === 12) return `- ${textOf(b.bullet ?? {})}`;
    if (t === 13) return `1. ${textOf(b.ordered ?? {})}`;
    if (t === 14) return `> ${textOf(b.quote ?? {})}`;
    return textOf(b.text ?? {});
  }).join('\n');
}

// 读飞书文档为 Markdown（凭据门控；wiki 链接自动换 obj_token 且仅支持 docx 类节点）
export async function readDoc(ref) {
  if (!feishuConfigured()) {
    const err = new Error('飞书未配置（server/.env 设置 FEISHU_APP_ID/FEISHU_APP_SECRET，应用需开通 docx 读权限）');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const parsed = parseDocRef(ref);
  if (!parsed) throw Object.assign(new Error('无法解析文档引用（支持 /docx/、/wiki/ 链接或裸 token）'), { code: 'BAD_REF' });
  const token = await getToken();
  let docId = parsed.token;
  if (parsed.kind === 'wiki') {
    const node = await apiGet(`/wiki/v2/spaces/get_node?token=${parsed.token}`, token);
    if (node.obj_type !== 'docx') throw new Error(`wiki 节点类型 ${node.obj_type} 暂不支持读入（当前仅 docx）`);
    docId = node.obj_token;
  }
  const doc = await apiGet(`/docx/v1/documents/${docId}`, token);
  // 直接子块分页（root block id = document_id；官方 blocks/children 接口，≤50/页）
  const items = [];
  let pageToken = '';
  for (let guard = 0; guard < 100; guard++) {
    const qs = `page_size=50${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
    const data = await apiGet(`/docx/v1/documents/${docId}/blocks/${docId}/children?${qs}`, token);
    items.push(...(data.items ?? []));
    if (!data.has_more) break;
    pageToken = data.page_token ?? '';
  }
  return { document_id: docId, title: doc.document?.title ?? '', markdown: blocks2md(items), blocks: items.length };
}
