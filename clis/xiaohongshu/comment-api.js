/**
 * Comment-operations toolkit for Xiaohongshu: read whole comment threads with
 * ids, read the "评论和@" inbox, and write replies / likes — all through the
 * web app's own signed wrappers, found in the webpack module graph.
 *
 * Why the bundled wrappers and not fetch(): see comment-helpers.js — xhs web
 * APIs need `x-s` / `x-t` / `x-s-common`, which only the app's axios instance
 * produces. The wrappers this file relies on (probed 2026-11-20, logged in, on
 * both a note page and /notification):
 *
 *   getApiSnsWebV2CommentPage({ params })     GET  /api/sns/web/v2/comment/page
 *   getApiSnsWebV2CommentSubPage({ params })  GET  /api/sns/web/v2/comment/sub/page
 *   postApiSnsWebV1CommentPost(body)          POST /api/sns/web/v1/comment/post
 *   postApiSnsWebV1CommentLike(body)          POST /api/sns/web/v1/comment/like
 *   (dislike)                                 POST /api/sns/web/v1/comment/dislike
 *   fetchMentions(num, cursor)                GET  /api/sns/web/v1/you/mentions
 *
 * All of them are already instantiated on /notification, so the inbox flow
 * needs a single navigation. The axios interceptor hands back the unwrapped,
 * camelCased `data` object (e.g. `{ comments, cursor, hasMore, userId }`); the
 * readers below accept snake_case too in case that interceptor changes.
 *
 * Node-side helpers (normalising rows, deciding what is still unanswered) are
 * pure and unit-tested; the browser-side builders return JS source strings.
 */

import fs from 'node:fs';
import { ArgumentError } from '@jackwener/opencli/errors';
import { resolveNoteTarget, XHS_HEX_ID_RE } from './comment-helpers.js';

export const XHS_WEB = 'https://www.xiaohongshu.com';
export const NOTIFICATION_URL = `${XHS_WEB}/notification`;

export const ENDPOINTS = {
    commentPage: '/api/sns/web/v2/comment/page',
    commentSubPage: '/api/sns/web/v2/comment/sub/page',
    commentPost: '/api/sns/web/v1/comment/post',
    commentLike: '/api/sns/web/v1/comment/like',
    commentDislike: '/api/sns/web/v1/comment/dislike',
    mentions: '/api/sns/web/v1/you/mentions',
};

/**
 * Browser-side prelude. Defines:
 *   __xhsApi(endpoint, verb?)  the bundled wrapper whose source names `endpoint`
 *                              (and, when given, contains `verb`, e.g. '.get(')
 *   __xhsClone(x)              plain-JSON copy (strips Vue proxies)
 *   __xhsWait(ms) / __xhsJitter(min, max)
 *   __xhsViewerId()            logged-in user id from the `user` Pinia store
 *   __xhsErr(err)              `{ ok: false, reason: 'api_error', code, message }`
 */
export const API_PRELUDE_JS = `
  const __xhsClone = (x) => { try { return JSON.parse(JSON.stringify(x)); } catch { return null; } };
  const __xhsWait = (ms) => new Promise((r) => setTimeout(r, ms));
  const __xhsJitter = (min, max) => __xhsWait(min + Math.random() * (max - min));
  const __xhsReq = (() => {
    const chunk = window.webpackChunkxhs_pc_web;
    if (!Array.isArray(chunk)) return null;
    let req = null;
    try { chunk.push([['__opencli_xhs_ops__' + Math.random()], {}, (r) => { req = r; }]); } catch { return null; }
    return typeof req === 'function' ? req : null;
  })();
  const __xhsApi = (endpoint, verb) => {
    if (!__xhsReq) return null;
    const pick = (mod) => {
      if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) return null;
      let keys = [];
      try { keys = Object.keys(mod); } catch { return null; }
      for (const k of keys) {
        let fn = null;
        try { fn = mod[k]; } catch { continue; }
        if (typeof fn !== 'function') continue;
        let src = '';
        try { src = String(fn); } catch { continue; }
        // Match the quoted endpoint exactly so '/comment/page' never picks '/comment/pag…' lookalikes.
        if (src.indexOf('"' + endpoint + '"') === -1) continue;
        if (verb && src.indexOf(verb) === -1) continue;
        return fn;
      }
      return null;
    };
    const cache = __xhsReq.c || {};
    for (const id of Object.keys(cache)) {
      const hit = pick(cache[id] && cache[id].exports);
      if (hit) return hit;
    }
    const factories = __xhsReq.m || {};
    for (const id of Object.keys(factories)) {
      let src = '';
      try { src = String(factories[id]); } catch { continue; }
      if (src.indexOf(endpoint) === -1) continue;
      let mod = null;
      try { mod = __xhsReq(id); } catch { continue; }
      const hit = pick(mod);
      if (hit) return hit;
    }
    return null;
  };
  const __xhsViewerId = () => {
    try {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const info = pinia._s.get('user').$state.userInfo || {};
      return info.userId || info.user_id || null;
    } catch { return null; }
  };
  const __xhsLoggedOut = () => /登录后查看|请登录/.test(document.body?.innerText || '') && !__xhsViewerId();
  const __xhsErr = (err) => {
    const data = err && err.data ? __xhsClone(err.data) : null;
    const code = (data && (data.code !== undefined ? data.code : data.result && data.result.code)) ?? (err && err.code);
    const message = (data && (data.msg || data.message)) || (err && (err.msg || err.message)) || String(err);
    return { ok: false, reason: 'api_error', code: code === undefined ? null : code, message: String(message) };
  };
  const __xhsBody = (r) => {
    const x = __xhsClone(r) || {};
    return (x.comments || x.messageList || x.message_list || x.comment) ? x : (x.data && typeof x.data === 'object' ? x.data : x);
  };
`;

/**
 * Browser-side function source: `__xhsFetchThread(noteId, xsecToken, opts)`.
 * Pages through top-level comments and (unless `withSubs` is false) every
 * reply thread. Stops early once `stopAtId` has been seen. Raw comment objects
 * are returned untouched; normalisation happens in Node (`normalizeComment`).
 */
export const FETCH_THREAD_JS = `
  const __xhsFetchThread = async (noteId, xsecToken, opts = {}) => {
    const maxTop = opts.maxTop || 500;
    const withSubs = opts.withSubs !== false;
    const stopAtId = opts.stopAtId || '';
    const pageFn = __xhsApi(${JSON.stringify(ENDPOINTS.commentPage)}, '.get(');
    const subFn = __xhsApi(${JSON.stringify(ENDPOINTS.commentSubPage)}, '.get(');
    if (!pageFn || (withSubs && !subFn)) return { ok: false, reason: 'api_unavailable' };
    const base = { note_id: noteId, image_formats: 'jpg,webp,avif', top_comment_id: '', xsec_token: xsecToken || '' };
    const items = [];
    let viewerId = null, cursor = '', top = 0, pages = 0, truncated = false, found = false;
    try {
      for (;;) {
        const d = __xhsBody(await pageFn({ params: { ...base, cursor } }));
        viewerId = viewerId || d.userId || d.user_id || null;
        for (const c of d.comments || []) {
          top++;
          items.push({ root: '', c });
          if (c.id === stopAtId) found = true;
          for (const s of c.subComments || c.sub_comments || []) {
            items.push({ root: c.id, c: s });
            if (s.id === stopAtId) found = true;
          }
          let more = c.subCommentHasMore ?? c.sub_comment_has_more;
          let subCursor = c.subCommentCursor ?? c.sub_comment_cursor ?? '';
          let guard = 0;
          while (withSubs && more && !found && guard++ < 100) {
            await __xhsJitter(300, 800);
            const sd = __xhsBody(await subFn({ params: { ...base, root_comment_id: c.id, num: 10, cursor: subCursor } }));
            for (const s of sd.comments || []) {
              items.push({ root: c.id, c: s });
              if (s.id === stopAtId) found = true;
            }
            more = sd.hasMore ?? sd.has_more;
            subCursor = sd.cursor ?? '';
            if (!subCursor) break;
          }
          if (found || top >= maxTop) break;
        }
        pages++;
        const hasMore = d.hasMore ?? d.has_more;
        cursor = d.cursor || '';
        if (found) break;
        if (top >= maxTop) { truncated = !!hasMore; break; }
        if (!hasMore || !cursor || pages >= 200) break;
        await __xhsJitter(400, 1000);
      }
    } catch (err) {
      return __xhsErr(err);
    }
    return { ok: true, viewerId: viewerId || __xhsViewerId(), items, truncated };
  };
`;

/** Read a field that the interceptor may hand back camelCased or snake_cased. */
function pick(obj, ...keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    }
    return undefined;
}

function toInt(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Epoch (seconds or ms) → ISO-8601 with +08:00 dropped to UTC Z; '' when unknown. */
export function toIsoTime(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms).toISOString();
}

/** Flatten one raw comment (top-level when `rootId` is ''). */
export function normalizeComment(raw, rootId = '') {
    const user = pick(raw, 'userInfo', 'user_info') || {};
    const target = pick(raw, 'targetComment', 'target_comment') || {};
    const targetUser = pick(target, 'userInfo', 'user_info') || {};
    const tags = pick(raw, 'showTags', 'show_tags') || [];
    return {
        comment_id: String(raw?.id ?? ''),
        root_id: rootId || '',
        reply_to_id: String(target.id ?? '') || (rootId || ''),
        reply_to_user: String(pick(targetUser, 'nickname') ?? ''),
        user_id: String(pick(user, 'userId', 'user_id', 'userid') ?? ''),
        author: String(pick(user, 'nickname') ?? ''),
        text: String(raw?.content ?? ''),
        likes: toInt(pick(raw, 'likeCount', 'like_count')),
        replies: toInt(pick(raw, 'subCommentCount', 'sub_comment_count')),
        time: toIsoTime(pick(raw, 'createTime', 'create_time')),
        ip: String(pick(raw, 'ipLocation', 'ip_location') ?? ''),
        is_author: Array.isArray(tags) && tags.includes('is_author'),
        is_ai: Boolean(pick(user, 'aiAgent', 'ai_agent')),
        images: (pick(raw, 'pictures') || []).length,
    };
}

/** Normalise `__xhsFetchThread` items into rows, de-duplicated by id. */
export function threadRows(items) {
    const seen = new Set();
    const rows = [];
    for (const item of items || []) {
        const row = normalizeComment(item.c, item.root);
        if (!row.comment_id || seen.has(row.comment_id)) continue;
        seen.add(row.comment_id);
        rows.push(row);
    }
    return rows;
}

/**
 * Mark every row with `replied` (did the viewer answer it?).
 *
 * A comment counts as answered when the viewer posted a reply that targets it,
 * or targets a later comment by the same person in the same thread (the
 * conversation moved on, so the older question was handled there). The
 * viewer's own comments and AI-agent comments (e.g. 点点) are `null`: there is
 * nothing to answer.
 */
export function markReplied(rows, viewerId) {
    const byId = new Map(rows.map(r => [r.comment_id, r]));
    const answeredIds = new Set();
    for (const r of rows) {
        if (!viewerId || r.user_id !== viewerId) continue;
        if (r.reply_to_id) answeredIds.add(r.reply_to_id);
    }
    const threadOf = (r) => r.root_id || r.comment_id;
    return rows.map((r) => {
        if (r.user_id === viewerId || r.is_ai) return { ...r, replied: null };
        if (answeredIds.has(r.comment_id)) return { ...r, replied: true };
        const later = rows.some(o => o.user_id === r.user_id
            && o.comment_id !== r.comment_id
            && threadOf(o) === threadOf(r)
            && o.time >= r.time
            && answeredIds.has(o.comment_id));
        return { ...r, replied: later };
    }).map((r) => {
        // Keep reply_to_user filled for direct replies to a root comment.
        if (!r.reply_to_user && r.root_id && byId.has(r.root_id)) {
            return { ...r, reply_to_user: byId.get(r.root_id).author };
        }
        return r;
    });
}

/** Signed note URL from a note id plus the xsec_token the inbox hands back. */
export function signedNoteUrl(noteId, xsecToken, source = 'pc_notice') {
    if (!noteId || !xsecToken) return '';
    return `${XHS_WEB}/explore/${noteId}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=${source}`;
}

const MENTION_KINDS = {
    'comment/item': 'comment',
    'comment/comment': 'reply',
    'mention/item': 'mention',
    'mention/comment': 'mention',
};

/** Flatten one `/you/mentions` message. */
export function normalizeMention(raw) {
    const user = pick(raw, 'userInfo', 'user_info') || {};
    const comment = pick(raw, 'commentInfo', 'comment_info') || {};
    const item = pick(raw, 'itemInfo', 'item_info') || {};
    const type = String(raw?.type ?? '');
    const noteId = String(item.id ?? '');
    const token = String(pick(item, 'xsecToken', 'xsec_token') ?? '');
    const target = pick(comment, 'targetComment', 'target_comment') || {};
    return {
        msg_id: String(raw?.id ?? ''),
        kind: MENTION_KINDS[type] || type || 'other',
        title: String(raw?.title ?? ''),
        user: String(pick(user, 'nickname') ?? ''),
        user_id: String(pick(user, 'userid', 'userId', 'user_id') ?? ''),
        text: String(comment.content ?? ''),
        comment_id: String(comment.id ?? ''),
        reply_to_text: String(target.content ?? ''),
        note_id: noteId,
        note: String(item.content ?? ''),
        time: toIsoTime(raw?.time),
        note_url: signedNoteUrl(noteId, token),
        xsec_token: token,
    };
}

/** Pull the xsec_token out of a signed note URL ('' when absent). */
export function xsecTokenOf(noteUrl) {
    try {
        return new URL(noteUrl).searchParams.get('xsec_token') || '';
    } catch {
        return '';
    }
}

/** Polite pause between writes, in seconds (default 30–60 s). */
export function writeSpacingSeconds(minS = 30, maxS = 60, rand = Math.random) {
    return Math.round(minS + rand() * Math.max(0, maxS - minS));
}

/**
 * Join inbox messages with the threads they belong to.
 * `threads` maps note_id → `{ rows, viewerId }` (rows already through markReplied).
 * `replied` is true / false, or null when the comment is no longer in the
 * thread (deleted, folded by moderation, or beyond what was read).
 */
export function joinInbox(messages, threads) {
    const seen = new Set();
    const out = [];
    for (const m of messages) {
        if (seen.has(m.comment_id)) continue;
        seen.add(m.comment_id);
        const t = threads.get(m.note_id);
        const row = t?.rows.find(r => r.comment_id === m.comment_id);
        // AI agents (点点) and your own comments have nothing to answer.
        if (row && (row.is_ai || row.replied === null)) continue;
        out.push({ ...m, replied: row ? row.replied : null, root_id: row?.root_id ?? '' });
    }
    return out;
}

/** Validate one reply job; returns `{ noteId, noteUrl, commentId, text }`. */
export function parseReplyJob(job, label = 'xiaohongshu/reply') {
    const { noteId, noteUrl } = resolveNoteTarget(job.note ?? job.note_url, label);
    const commentId = String(job.comment_id ?? job.comment ?? '').trim();
    if (!XHS_HEX_ID_RE.test(commentId)) {
        throw new ArgumentError(`${label}: comment id must be a 24-character hex id (see comment-list / inbox)`);
    }
    const text = String(job.text ?? '').trim();
    if (!text) throw new ArgumentError(`${label}: reply text cannot be empty`);
    return { noteId, noteUrl, commentId, text };
}

/** Parse a JSON array or JSONL file of `{ note|note_url, comment_id, text }`. */
export function readReplyJobs(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        throw new ArgumentError(`xiaohongshu/reply-batch: cannot read ${file}: ${err.message}`);
    }
    const trimmed = raw.trim();
    let jobs;
    try {
        jobs = trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch (err) {
        throw new ArgumentError(`xiaohongshu/reply-batch: ${file} is not JSON / JSONL: ${err.message}`);
    }
    return jobs.map(j => parseReplyJob(j, 'xiaohongshu/reply-batch'));
}
