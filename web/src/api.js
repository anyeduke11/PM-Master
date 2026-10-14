// 集中式 fetch 门面：统一 !r.ok 检查与错误信息提取（解析 JSON 的 message 字段）
// 语义与既有 j() helper 一致，供各页面复用，避免重复实现。
async function request(method, url, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  if (!r.ok) {
    const msg = await r.json().then((d) => d?.message).catch(() => null);
    throw new Error(msg ?? `HTTP ${r.status}`);
  }
  return r.json();
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  del: (url, body) => request('DELETE', url, body),
};