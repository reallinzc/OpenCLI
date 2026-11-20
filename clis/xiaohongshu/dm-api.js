/**
 * Private-message (私信) toolkit for Xiaohongshu: list conversations, read one,
 * and decide whether a message may be sent — all through the web IM SDK the
 * page itself uses, found in the webpack module graph.
 *
 * What the web app does (probed 2026-11-20, logged in, on /chat):
 *   - A singleton `X.getInstance()` (module that names "/api/im/web/v3/chats")
 *     owns `.sdk`, a signed request client with, among others:
 *       getChatList({ limit, complete, page, next_ts })  GET /api/im/web/v3/chats
 *         -> { data: { chats: [{ chatUserId, userId, lastMsgContent,
 *              lastMsgTime, info: { nickname, followStatus, ... } }], page, nextTs } }
 *       getChatInfoV3({ chatUserIds })                   GET /api/im/web/v3/chats/info
 *         -> { data: { [uid]: { nickname, isBlock, followStatus,
 *              showStrangerLimitHint, ... } } }
 *       getChatMessageHistory({ chatUserId, limit })     GET /api/im/web/messages/history
 *         -> { data: [newest first: { id, senderId, receiverId, createdAt,
 *              content: '{"content","content_type","front_chain"}', revoked }] }
 *       getChatUnreadCounts()  -> { data: { userChatUnreadCounts: { [uid]: n } } }
 *     Strangers are in the same list as everyone else (204 chats, mixed
 *     followStatus NONE / FANS / FOLLOWS / BOTH).
 *   - Sending goes through a long-link socket with an HTTP fallback, wrapped in
 *     the chat view's own message model. `dm-send` therefore types into the
 *     real chat box (CDP insertText + Enter) instead of rebuilding that model,
 *     and reads the history back to confirm. In the editor, Enter sends and
 *     Shift+Enter is a line break (`handleEditorKeydown`, same probe).
 *   - Before a stranger answers, the account may only send a limited number
 *     of messages (`showStrangerLimitHint`); a second unanswered message is
 *     refused here instead of being tried.
 */

import { ArgumentError } from '@jackwener/opencli/errors';
import { API_PRELUDE_JS, XHS_WEB, toIsoTime } from './comment-api.js';
import { XHS_HEX_ID_RE } from './comment-helpers.js';

export const CHAT_URL = `${XHS_WEB}/chat`;
export const CHAT_EDITOR_SELECTOR = '.xhs-im-input-bar-editor';

export function chatUrlFor(userId) {
    return `${CHAT_URL}?openUid=${encodeURIComponent(userId)}`;
}

/** Accepts a 24-hex user id, a profile URL or a /chat?openUid= URL. */
export function resolveDmUser(raw, label) {
    const input = String(raw ?? '').trim();
    if (XHS_HEX_ID_RE.test(input)) return input.toLowerCase();
    if (/^https?:\/\//i.test(input)) {
        let url;
        try {
            url = new URL(input);
        } catch {
            url = null;
        }
        if (url && /(^|\.)xiaohongshu\.com$/i.test(url.hostname)) {
            const fromQuery = url.searchParams.get('openUid') ?? url.searchParams.get('user_id');
            if (fromQuery && XHS_HEX_ID_RE.test(fromQuery)) return fromQuery.toLowerCase();
            const m = url.pathname.match(/\/user\/profile\/([a-f0-9]{24})/i);
            if (m) return m[1].toLowerCase();
        }
    }
    throw new ArgumentError(`${label}: user must be a 24-character user id, a profile URL or a /chat?openUid= URL (see dm-list / inbox user_id)`);
}

/**
 * Browser-side prelude: API_PRELUDE_JS plus
 *   __xhsIm()               the IM singleton (has `.sdk`), or null
 *   __xhsImReady(ms)        resolves the singleton once its init finished
 *   __xhsDmHistory(uid, n)  newest-first raw messages
 *   __xhsDmInfo(uid)        raw chat info for one user
 */
export const IM_PRELUDE_JS = `
  ${API_PRELUDE_JS}
  const __xhsIm = () => {
    if (!__xhsReq) return null;
    const look = (mod) => {
      if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) return null;
      let keys = [];
      try { keys = Object.keys(mod); } catch { return null; }
      for (const k of keys) {
        let v = null;
        try { v = mod[k]; } catch { continue; }
        if (!v || typeof v.getInstance !== 'function') continue;
        try {
          const inst = v.getInstance();
          if (inst && inst.sdk && typeof inst.sdk.getChatList === 'function') return inst;
        } catch { /* not ours */ }
      }
      return null;
    };
    const cache = __xhsReq.c || {};
    for (const id of Object.keys(cache)) {
      const hit = look(cache[id] && cache[id].exports);
      if (hit) return hit;
    }
    const factories = __xhsReq.m || {};
    for (const id of Object.keys(factories)) {
      let src = '';
      try { src = String(factories[id]); } catch { continue; }
      if (src.indexOf('"/api/im/web/v3/chats"') === -1) continue;
      let mod = null;
      try { mod = __xhsReq(id); } catch { continue; }
      const hit = look(mod);
      if (hit) return hit;
    }
    return null;
  };
  const __xhsImReady = async (ms) => {
    const inst = __xhsIm();
    if (!inst) return null;
    if (typeof inst.waitForInit === 'function') {
      await Promise.race([Promise.resolve(inst.waitForInit()).catch(() => {}), __xhsWait(ms)]);
    }
    return inst;
  };
  const __xhsDmHistory = async (sdk, uid, limit) => {
    const r = __xhsClone(await sdk.getChatMessageHistory({ chatUserId: uid, limit })) || {};
    return Array.isArray(r.data) ? r.data : [];
  };
  const __xhsDmInfo = async (sdk, uid) => {
    const r = __xhsClone(await sdk.getChatInfoV3({ chatUserIds: uid })) || {};
    return (r.data && r.data[uid]) || null;
  };
`;

/** Browser script: one user's chat info + newest `limit` messages. */
export function buildDmThreadScript(userId, limit) {
    return `
(async () => {
  ${IM_PRELUDE_JS}
  if (__xhsLoggedOut()) return { ok: false, reason: 'login_wall' };
  const inst = await __xhsImReady(8000);
  if (!inst) return { ok: false, reason: 'api_unavailable' };
  try {
    const info = await __xhsDmInfo(inst.sdk, ${JSON.stringify(userId)});
    const messages = await __xhsDmHistory(inst.sdk, ${JSON.stringify(userId)}, ${Number(limit) || 20});
    return { ok: true, viewerId: inst.currentUserId || __xhsViewerId(), info, messages };
  } catch (err) {
    return __xhsErr(err);
  }
})()
`;
}

/** Browser script: conversation list (+ unread, + newest message of each when `withLast`). */
export function buildDmChatsScript({ limit, withLast }) {
    return `
(async () => {
  ${IM_PRELUDE_JS}
  if (__xhsLoggedOut()) return { ok: false, reason: 'login_wall' };
  const inst = await __xhsImReady(8000);
  if (!inst) return { ok: false, reason: 'api_unavailable' };
  const sdk = inst.sdk;
  const want = ${Number(limit) || 20};
  const chats = [];
  let unread = {};
  try {
    let page = 0, nextTs, rounds = 0;
    for (;;) {
      const r = __xhsClone(await sdk.getChatList({ limit: Math.min(50, want), complete: true, page, next_ts: nextTs })) || {};
      const d = r.data || {};
      for (const c of d.chats || []) { chats.push(c); if (chats.length >= want) break; }
      rounds++;
      if (chats.length >= want || !(d.chats || []).length || !d.nextTs || rounds >= 20) break;
      page = (d.page || page) + 1; nextTs = d.nextTs;
      await __xhsJitter(400, 900);
    }
    try {
      const u = __xhsClone(await sdk.getChatUnreadCounts()) || {};
      unread = (u.data && u.data.userChatUnreadCounts) || {};
    } catch { unread = {}; }
    if (${withLast ? 'true' : 'false'}) {
      for (const c of chats) {
        try { c.__last = (await __xhsDmHistory(sdk, c.chatUserId, 1))[0] || null; } catch { c.__last = null; }
        await __xhsJitter(250, 700);
      }
    }
  } catch (err) {
    return __xhsErr(err);
  }
  return { ok: true, viewerId: inst.currentUserId || __xhsViewerId(), chats, unread };
})()
`;
}

/** Browser script: state of the chat box (for dm-send). */
export function buildEditorStateScript(action) {
    return `
(() => {
  const ed = document.querySelector(${JSON.stringify(CHAT_EDITOR_SELECTOR)});
  if (!ed) return { ok: false, reason: 'editor_missing' };
  if (${JSON.stringify(action)} === 'clear') {
    ed.focus();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
  }
  const toast = [...document.querySelectorAll('[class*=toast], [class*=Toast], [class*=tips], [class*=hint]')]
    .filter((e) => e.offsetParent && (e.innerText || '').trim()).map((e) => e.innerText.trim()).slice(-3);
  return { ok: true, text: ed.innerText || '', toast };
})()
`;
}

const TYPE_NAMES = { 1: 'text', 2: 'image', 3: 'card' };

/** One history entry -> output row. `content` is a JSON string on the wire. */
export function normalizeDmMessage(raw, viewerId) {
    let parsed = {};
    try {
        parsed = typeof raw.content === 'string' ? JSON.parse(raw.content) : (raw.content ?? {});
    } catch {
        parsed = { content: String(raw.content ?? '') };
    }
    const ct = Number(parsed.content_type ?? parsed.contentType ?? 0);
    const type = raw.revoked ? 'revoked' : (TYPE_NAMES[ct] ?? `type-${ct}`);
    const text = raw.revoked ? '[已撤回]'
        : ct === 1 ? String(parsed.content ?? '')
            : String(parsed.front_chain ?? parsed.frontChain ?? `[${type}]`);
    return {
        message_id: String(raw.id ?? ''),
        time: toIsoTime(raw.createdAt ?? raw.created_at),
        from: raw.senderId === viewerId ? 'me' : 'them',
        type,
        text,
        sender_id: String(raw.senderId ?? ''),
    };
}

/** History (newest first on the wire) -> rows oldest first. */
export function dmMessageRows(messages, viewerId) {
    return [...(messages ?? [])].map(m => normalizeDmMessage(m, viewerId)).reverse();
}

export function normalizeDmChat(raw, unread, viewerId) {
    const info = raw.info ?? {};
    const last = raw.__last ? normalizeDmMessage(raw.__last, viewerId) : null;
    return {
        user: info.nickname ?? info.userName ?? '',
        user_id: String(raw.chatUserId ?? ''),
        last_message: last ? last.text : String(raw.lastMsgContent ?? ''),
        last_from: last ? last.from : null,
        last_time: toIsoTime(raw.lastMsgTime),
        unread: Number(unread?.[raw.chatUserId] ?? 0),
        follow: String(info.followStatus ?? ''),
    };
}

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Whether `text` may be sent to this user now. Returns
 *   { status: 'ok' | 'already-sent' | 'stranger-limit' | 'blocked', detail }
 */
export function dmSendDecision({ info, rows, text }) {
    if (info?.isBlock || info?.isBlocked) return { status: 'blocked', detail: 'this user is blocked' };
    if (rows.some(r => r.from === 'me' && squash(r.text) === squash(text))) {
        return { status: 'already-sent', detail: 'the same text is already in this conversation' };
    }
    const mine = rows.filter(r => r.from === 'me').length;
    const theirs = rows.filter(r => r.from === 'them').length;
    if (info?.showStrangerLimitHint && mine > 0 && theirs === 0) {
        return { status: 'stranger-limit', detail: 'they have not answered yet; strangers only get a limited number of messages' };
    }
    return { status: 'ok', detail: info?.showStrangerLimitHint ? 'stranger: only the first message is guaranteed to go through until they answer' : '' };
}

export function splitDmLines(text) {
    return String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
}

export const __test__ = { squash };
