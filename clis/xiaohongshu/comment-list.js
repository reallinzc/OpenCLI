/**
 * Xiaohongshu comment-list — the whole comment tree of a note through the
 * signed comment APIs, with the ids that `reply` / `comment-like` /
 * `comment-delete` need, and (on your own notes) whether you already answered.
 *
 * `comments` scrolls the rendered page and returns text only; this reads the
 * same `/api/sns/web/v2/comment/page` + `/sub/page` the page itself calls, so
 * every reply thread is complete and each row carries its id, its thread root
 * and the comment it answers.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { resolveNoteTarget } from './comment-helpers.js';
import { API_PRELUDE_JS, FETCH_THREAD_JS, NOTIFICATION_URL, markReplied, threadRows, xsecTokenOf } from './comment-api.js';
import { unwrapEvaluateResult } from './shared.js';
import { jitterSeconds } from './risk-control.js';

const LABEL = 'xiaohongshu/comment-list';

export function buildThreadScript(noteId, xsecToken, opts) {
    return `
(async () => {
  ${API_PRELUDE_JS}
  ${FETCH_THREAD_JS}
  if (__xhsLoggedOut()) return { ok: false, reason: 'login_wall' };
  return await __xhsFetchThread(${JSON.stringify(noteId)}, ${JSON.stringify(xsecToken)}, ${JSON.stringify(opts)});
})()
`;
}

/** Shared by comment-list / reply / inbox: open /notification and settle. */
export async function openXhsWorkspace(page) {
    await page.goto(NOTIFICATION_URL);
    await page.wait({ time: jitterSeconds(2, 4) });
}

export function requireThread(result, label) {
    const r = unwrapEvaluateResult(result);
    if (!r || typeof r !== 'object') throw new CommandExecutionError(`${label}: malformed thread payload`);
    if (!r.ok) {
        if (r.reason === 'login_wall') throw new AuthRequiredError('www.xiaohongshu.com');
        if (r.reason === 'api_unavailable') {
            throw new CommandExecutionError(`${label}: the page's comment API is unreachable; the site bundle may have changed.`);
        }
        throw new CommandExecutionError(`${label} failed: ${r.message ?? r.reason}${r.code != null ? ` (code ${r.code})` : ''}`);
    }
    return r;
}

cli({
    site: 'xiaohongshu',
    name: 'comment-list',
    access: 'read',
    description: '小红书笔记的完整评论树（含评论 ID、楼中楼、回复对象；自己的笔记标出是否已回复）',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
        { name: 'note', required: true, positional: true, help: 'Full note URL with xsec_token' },
        { name: 'limit', type: 'int', default: 200, help: 'Max top-level comments to read' },
        { name: 'unreplied', type: 'boolean', default: false, help: 'Only rows you have not answered yet' },
        { name: 'timeout', type: 'int', default: 300, help: 'Time limit in seconds (long threads page slowly on purpose)' },
    ],
    columns: ['comment_id', 'root_id', 'author', 'text', 'reply_to_user', 'likes', 'replies', 'time', 'ip', 'replied', 'is_author', 'user_id', 'reply_to_id'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('Browser session required for xiaohongshu comment-list');
        const { noteId, noteUrl } = resolveNoteTarget(kwargs.note, LABEL);
        await openXhsWorkspace(page);
        const r = requireThread(await page.evaluate(buildThreadScript(noteId, xsecTokenOf(noteUrl), {
            maxTop: Math.max(1, Number(kwargs.limit) || 200),
        })), LABEL);
        let rows = markReplied(threadRows(r.items), r.viewerId);
        if (kwargs.unreplied) rows = rows.filter(row => row.replied === false);
        if (r.truncated) process.stderr.write(`${LABEL}: stopped at --limit ${kwargs.limit}; more comments exist.\n`);
        return rows;
    },
});

export const __test__ = { buildThreadScript, requireThread };
