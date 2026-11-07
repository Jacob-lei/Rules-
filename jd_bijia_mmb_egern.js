// 京东比价 · Egern 原生版（慢慢买数据源）

const STORE_KEY = 'jd_bijia_mmb_params';
const SECRET_KEY = '3E41D1331F5DDAFCD0A38FE2D52FF66F';
const MMB_HISTORY_HOST = 'https://apapia-history-weblogic.manmanbuy.com';
const MMB_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 - mmbWebBrowse - ios';

export default async function (ctx) {
  const url = ctx.request.url || '';

  // ---- 1. 捕获慢慢买参数：慢慢买 App 打开“我的”时会请求 /baoliao/center/menu ----
  if (/^https?:\/\/apapia-sqk-weblogic\.manmanbuy\.com\/baoliao\/center\/menu(?:\?|$)/i.test(url)) {
    try {
      const bodyText = await ctx.request.text();
      const params = parseForm(bodyText);
      if (!params.c_mmbDevId) {
        ctx.notify({ title: '京东比价', body: '参数未捕获，请重新进入慢慢买 App 的“我的”页面。' });
        return { body: bodyText };
      }
      for (const name of ['c_ctrl', 'methodName', 'level', 't', 'token']) delete params[name];
      ctx.storage.setJSON(STORE_KEY, params);
      ctx.notify({ title: '京东比价', body: '参数已保存，现在可进入京东商品详情查看历史比价。' });
      return { body: bodyText };
    } catch (e) {
      return;
    }
  }

  // ---- 2. 京东商品图文详情页：查慢慢买历史价并插表 ----
  const match = url.match(/^https?:\/\/in\.m\.jd\.com\/product\/graphext\/(\d+)\.html(?:\?|$)/i);
  if (!match) return;

  const productId = match[1];
  let originalBody;
  try {
    originalBody = await ctx.response.text();
  } catch (e) {
    return;
  }
  if (!originalBody || !/<body\b[^>]*>/i.test(originalBody)) return;
  if (originalBody.includes('id="jd-bijia-mmb"')) return;

  const insert = (content) =>
    originalBody.replace(/<body\b[^>]*>/i, (opening) => opening + content);
  const panel = (content) =>
    `<div id="jd-bijia-mmb" style="max-width:95%;margin:8px auto;padding:10px;background:#fff9f9;color:#333;border:1px solid #e0e0e0;border-radius:8px;font-size:13px;">${content}</div>`;

  const saved = ctx.storage.getJSON(STORE_KEY);
  if (!saved || typeof saved !== 'object' || !saved.c_mmbDevId) {
    return {
      body: insert(panel('历史比价：请先打开慢慢买 App → 我的，收到“参数已保存”通知后，重新进入此商品。')),
    };
  }

  try {
    const jdUrl = `https://item.jd.com/${productId}.html`;
    const basic = await mmbRequest(ctx, saved, 'basic/getItemBasicInfo', {
      methodName: 'getHistoryInfoJava',
      searchKey: jdUrl,
      c_ctrl: 'Tabs',
    });
    if (!basic || basic.ok !== 1) throw new Error((basic && basic.msg) || '获取商品信息失败');
    if (!basic.result || !basic.result.url || !basic.result.spbh) throw new Error('未查询到该商品');

    const trend = await mmbRequest(ctx, saved, 'history/v2/getHistoryTrend', {
      methodName: 'getHistoryTrend2021',
      url: basic.result.url,
      spbh: basic.result.spbh,
      c_ctrl: 'TrendDetailScene',
      callPos: 'trend_detail',
      currentScene: 'TrendDetailRecent',
      eventName: '查询商品历史价格',
      pagecFrom: 'TrendHomeUnInput',
      chartStyleTest: 'testA',
    });
    if (!trend || trend.ok !== 1) throw new Error((trend && trend.msg) || '获取价格趋势失败');
    if (!trend.result || !trend.result.trend) throw new Error('该商品暂无历史价格');

    const remark = await mmbRequest(ctx, saved, 'history/priceRemark', {
      methodName: 'priceRemarkJava',
      jiagequshiyh: trend.result.trend,
      c_ctrl: 'TrendDetailScene',
    });
    if (!remark || remark.ok !== 1) throw new Error((remark && remark.msg) || '获取价格备注失败');
    const list = remark.remark && remark.remark.ListPriceDetail;
    if (!Array.isArray(list) || !list.length) throw new Error('该商品暂无可显示的比价记录');

    const html = generateHTML(list);
    if (!html) throw new Error('该商品暂无可显示的比价记录');
    return { body: insert(html) };
  } catch (e) {
    const msg = (e && e.message) || '查询失败';
    return {
      body: insert(panel(`历史比价暂不可用：${escapeHTML(msg)}。可打开慢慢买检查，或重新进慢慢买“我的”捕获参数。`)),
    };
  }
}

// ---- 慢慢买请求：带上本机保存的参数 + t 时间戳 + MD5 token 签名 ----
async function mmbRequest(ctx, saved, path, fields) {
  const params = Object.assign({}, saved, fields, { t: String(Date.now()) });
  const canonical = Object.keys(params)
    .filter((key) => params[key] !== '' && key.toLowerCase() !== 'token')
    .sort()
    .map((key) => key.toUpperCase() + String(params[key]).toUpperCase())
    .join('');
  params.token = md5(encodeURIComponent(SECRET_KEY + canonical + SECRET_KEY)).toUpperCase();
  const body = Object.keys(params)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');
  const resp = await ctx.http.post(`${MMB_HISTORY_HOST}/${path}`, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      'User-Agent': MMB_UA,
    },
    body,
    timeout: 10000,
  });
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('慢慢买返回的数据无法解析');
  }
}

function parseForm(value) {
  const result = {};
  for (const pair of String(value || '').split('&')) {
    const sep = pair.indexOf('=');
    if (sep < 0) continue;
    const decode = (text) => decodeURIComponent(text.replace(/\+/g, ' '));
    const name = decode(pair.slice(0, sep));
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') continue;
    result[name] = decode(pair.slice(sep + 1));
  }
  return result;
}

function escapeHTML(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

// ---- 价格表：只取这些行，差价 = 该行价格 - 当前到手价 ----
function generateHTML(list) {
  const wanted = new Set([
    '当前到手价', '历史最低价',
    '30天最低价', '60天最低价', '90天最低价', '180天最低价', '365天最低价',
    '618价格', '双11价格', '双12价格',
  ]);
  const rows = list.filter((row) => row && wanted.has(row.Name));
  if (!rows.length) return '';
  const current = rows.find((row) => row.Name === '当前到手价');
  const currentCents = current ? priceCents(current.Price) : null;
  const bodyRows = rows
    .map((row) => {
      const cents = priceCents(row.Price);
      let diff = '—';
      let diffClass = '';
      if (row.Name === '当前到手价') {
        diff = '基准价';
      } else if (currentCents !== null && cents !== null) {
        const delta = cents - currentCents;
        const amount = (Math.abs(delta) / 100).toFixed(2).replace(/\.?0+$/, '');
        diff = delta === 0 ? '0' : (delta > 0 ? '+' : '-') + amount;
        diffClass = delta > 0 ? 'up' : delta < 0 ? 'down' : '';
      }
      const date = row.Name === '当前到手价' ? new Date().toISOString().slice(0, 10) : row.Date || '—';
      return `<tr><td>${escapeHTML(row.Name)}</td><td>${escapeHTML(date)}</td><td>${escapeHTML(row.Price == null ? '—' : row.Price)}</td><td class="${diffClass}">${escapeHTML(diff)}</td></tr>`;
    })
    .join('');
  return `<div id="jd-bijia-mmb"><table class="price-table"><thead><tr><th>类型</th><th>日期</th><th>价格</th><th>差价</th></tr></thead><tbody>${bodyRows}</tbody></table><div class="footer"><span>差价＝该行价格－当前到手价；慢慢买历史价格 · 仅供参考</span></div></div><style>#jd-bijia-mmb{max-width:95%;margin:8px auto;padding:8px;background:#fff9f9;border-radius:8px;font-size:12px}#jd-bijia-mmb .price-table{width:100%;border-collapse:collapse;table-layout:fixed}#jd-bijia-mmb .price-table th{background:#e61a23;color:#fff;padding:8px 4px;text-align:left;font-size:11px}#jd-bijia-mmb .price-table td{padding:6px 4px;border-bottom:1px solid #f0f0f0;font-size:11px}#jd-bijia-mmb .up{color:#C91623;font-weight:bold}#jd-bijia-mmb .down{color:#00aa00;font-weight:bold}#jd-bijia-mmb .footer{font-size:10px;color:#999;padding-top:6px;text-align:right}</style>`;
}

function priceCents(value) {
  if (value == null) return null;
  const text = String(value).trim().replace(/^[¥￥]\s*/, '').replace(/元$/, '').trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return null;
  const parts = text.replace(/,/g, '').split('.');
  const cents = Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

// ---- MD5（纯 JS 实现，按 RFC 1321；对输入先做 UTF-8 编码） ----
function md5(input) {
  const utf8 = unescape(encodeURIComponent(input));
  const bytes = [];
  for (let i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i) & 0xff);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push((bitLen / Math.pow(2, i * 8)) & 0xff);

  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = [];
  for (let i = 0; i < 64; i++) K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const add = (x, y) => (x + y) >>> 0;
  const rotl = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;

  for (let off = 0; off < bytes.length; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) {
      M.push(
        bytes[off + i * 4] |
        (bytes[off + i * 4 + 1] << 8) |
        (bytes[off + i * 4 + 2] << 16) |
        (bytes[off + i * 4 + 3] << 24)
      );
    }
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F;
      let g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = add(add(add(F, A), K[i]), M[g]);
      A = D;
      D = C;
      C = B;
      B = add(B, rotl(F, S[i]));
    }
    a0 = add(a0, A);
    b0 = add(b0, B);
    c0 = add(c0, C);
    d0 = add(d0, D);
  }

  const wordHex = (w) => {
    let hex = '';
    for (let i = 0; i < 4; i++) hex += ('0' + ((w >>> (i * 8)) & 0xff).toString(16)).slice(-2);
    return hex;
  };
  return wordHex(a0) + wordHex(b0) + wordHex(c0) + wordHex(d0);
}
