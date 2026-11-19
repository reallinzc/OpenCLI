/**
 * Xiaohongshu inbox — the "评论和@" notifications as a work queue: who said
 * what on which note, with the comment id and a signed note URL ready for
 * `reply`, and whether you have already answered it.
 *
 * Flow (one navigation): open /notification, page through
 * `/api/sns/web/v1/you/mentions`, then read the comment thread of every note
 * that appears (`/comment/page` + `/sub/page`) to decide `replied` the same
 * way `comment-list` does. By default only unanswered items are returned.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { API_PRELUDE_JS, ENDPOINTS, joinInbox, markReplied, normalizeMention, threadRows } from './comment-api.js';
import { buildThreadScript, openXhsWorkspace, requireThread } from './comment-list.js';
import { unwrapEvaluateResult } from './shared.js';
import { jitterSeconds } from './risk-control.js';

const LABEL = 'xiaohongshu/inbox';

export function buildMentionsScript({ limit, sinceMs }) {
    return `
(async () => {
  ${API_PRELUDE_JS}
  if (__xhsLoggedOut()) return { ok: false, reason: 'login_wall' };
  const fetchMentions = __xhsApi(${JSON.stringify(ENDPOINTS.mentions)});
  if (!fetchMentions) return { ok: false, reason: 'api_unavailable' };
  const out = [];
  let cursor = '', pages = 0;
  try {
    for (;;) {
      const d = __xhsBody(await fetchMentions(20, cursor));
      const list = d.messageList || d.message_list || [];
      let old = false;
      for (const m of list) {
        if (${Number(sinceMs) || 0} && Number(m.time) * 1000 < ${Number(sinceMs) || 0}) { old = true; break; }
        out.push(m);
        if (out.length >= ${Number(limit) || 50}) break;
      }
      pages++;
      const more = d.hasMore ?? d.has_more;
      cursor = d.cursor ?? '';
      if (old || out.length >= ${Number(limit) || 50} || !more || !cursor || !list.length || pages >= 50) break;
      await __xhsJitter(500, 1200);
    }
  } catch (err) {
    return __xhsErr(err);
  }
  return { ok: true, viewerId: __xhsViewerId(), messages: out };
})()
`;
}


cli({
    site: 'xiaohongshu',
    name: 'inbox',
    access: 'read',
    description: '小红书“评论和@”待办：谁在哪篇笔记说了什么、评论 ID、带签名的笔记链接、是否已回复（默认只列未回复）',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
        { name: 'limit', type: 'int', default: 50, help: 'Max notifications to scan' },
        { name: 'days', type: 'int', default: 14, help: 'Only notifications from the last N days (0 = no cut-off)' },
        { name: 'all', type: 'boolean', default: false, help: 'Include items you already answered' },
        { name: 'max-notes', type: 'int', default: 20, help: 'Max distinct notes whose threads are read' },
        { name: 'exclude', help: 'Drop items whose text matches this regex, e.g. "求内测|蹲"' },
        { name: 'timeout', type: 'int', default: 300, help: 'Time limit in seconds (long threads page slowly on purpose)' },
    ],
    columns: ['rank', 'time', 'kind', 'user', 'text', 'note', 'replied', 'comment_id', 'note_url', 'reply_to_text', 'user_id', 'note_id', 'root_id'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('Browser session required for xiaohongshu inbox');
        const days = Number(kwargs.days ?? 14);
        const sinceMs = days > 0 ? Date.now() - days * 86400_000 : 0;
        await openXhsWorkspace(page);
        const res = unwrapEvaluateResult(await page.evaluate(buildMentionsScript({ limit: Number(kwargs.limit) || 50, sinceMs })));
        if (!res || typeof res !== 'object') throw new CommandExecutionError(`${LABEL}: malformed mentions payload`);
        if (!res.ok) {
            if (res.reason === 'login_wall') throw new AuthRequiredError('www.xiaohongshu.com');
            throw new CommandExecutionError(`${LABEL} failed: ${res.message ?? res.reason}${res.code != null ? ` (code ${res.code})` : ''}`);
        }
        const messages = res.messages.map(normalizeMention)
            .filter(m => m.comment_id && m.note_id && m.user_id !== res.viewerId);

        const threads = new Map();
        const noteIds = [...new Set(messages.map(m => m.note_id))].slice(0, Math.max(1, Number(kwargs['max-notes']) || 20));
        for (const [i, noteId] of noteIds.entries()) {
            if (i > 0) await page.wait({ time: jitterSeconds(1, 3) });
            const token = messages.find(m => m.note_id === noteId)?.xsec_token ?? '';
            try {
                const t = requireThread(await page.evaluate(buildThreadScript(noteId, token, {})), LABEL);
                threads.set(noteId, { rows: markReplied(threadRows(t.items), t.viewerId ?? res.viewerId), viewerId: t.viewerId });
            } catch (err) {
                process.stderr.write(`${LABEL}: could not read the thread of ${noteId}: ${err.message}\n`);
            }
        }

        let rows = joinInbox(messages, threads);
        if (!kwargs.all) rows = rows.filter(r => r.replied !== true);
        if (kwargs.exclude) {
            let re;
            try {
                re = new RegExp(String(kwargs.exclude));
            } catch (err) {
                throw new ArgumentError(`${LABEL}: --exclude is not a valid regex: ${err.message}`);
            }
            rows = rows.filter(r => !re.test(r.text));
        }
        return rows.map(({ xsec_token, msg_id, title, ...r }, i) => ({ rank: i + 1, ...r }));
    },
});

export const __test__ = { buildMentionsScript, joinInbox };
