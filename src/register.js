// src/register.js — 飞机注册号清洗与校验
/**
 * 将用户输入的注册号规范化。
 * @param {string} input
 * @returns {{ok:boolean, reg?:string, query?:string, raw?:string, error?:string}}
 *  - reg   正则化（去连字符，纯字母数字），用于展示/去重
 *  - query 供外网查询使用（转大写、去空格、保留连字符，如 B-2001）
 */
export function normalizeRegistration(input) {
  if (!input || typeof input !== 'string') {
    return { ok: false, error: '请输入飞机注册号' };
  }
  const raw = input.trim();
  const query = raw.toUpperCase().replace(/\s+/g, '');
  const reg = query.replace(/[^A-Z0-9]/g, '');
  if (!reg) {
    return { ok: false, error: '注册号不能为空' };
  }
  if (reg.length < 3 || reg.length > 12) {
    return { ok: false, error: `注册号 "${raw}" 长度异常，请检查` };
  }
  return { ok: true, reg, query, raw };
}
