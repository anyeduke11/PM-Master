// R6.4 错误风格体系化：面向用户的 HTTP 错误用本模块显式标注状态码，
// index.mjs setErrorHandler 读 err.statusCode 映射 4xx；未标注的内部错误保持 500（不误伤）。
// 用法约定：输入校验失败=badRequest(400)；资源不存在=notFound(404)；
// 资源状态不允许该操作=conflict(409)；等级/权限门槛未达=forbidden(403)。
export const badRequest = (msg) => Object.assign(new Error(msg), { statusCode: 400 });
export const notFound = (msg) => Object.assign(new Error(msg), { statusCode: 404 });
export const conflict = (msg) => Object.assign(new Error(msg), { statusCode: 409 });
export const forbidden = (msg) => Object.assign(new Error(msg), { statusCode: 403 });
