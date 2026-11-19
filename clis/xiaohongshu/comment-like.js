/**
 * Xiaohongshu comment-like — like (or with --undo, unlike) a comment by id,
 * through the page's own signed `/api/sns/web/v1/comment/like` (`/dislike`).
 * Without --execute nothing is written.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { resolveNoteTarget, XHS_HEX_ID_RE } from './comment-helpers.js';
import { API_PRELUDE_JS, ENDPOINTS } from './comment-api.js';
import { openXhsWorkspace } from './comment-list.js';
import { unwrapEvaluateResult } from './shared.js';

const LABEL = 'xiaohongshu/comment-like';

export function buildLikeScript({ noteId, commentId, undo }) {
    const endpoint = undo ? ENDPOINTS.commentDislike : ENDPOINTS.commentLike;
    return `
(async () => {
  ${API_PRELUDE_JS}
  const fn = __xhsApi(${JSON.stringify(endpoint)}, '.post(');
  if (!fn) return { ok: false, reason: 'api_unavailable' };
  try {
    await fn({ note_id: ${JSON.stringify(noteId)}, comment_id: ${JSON.stringify(commentId)} });
    return { ok: true };
  } catch (err) {
    return __xhsErr(err);
  }
})()
`;
}

cli({
    site: 'xiaohongshu',
    name: 'comment-like',
    access: 'write',
    description: '给小红书评论点赞（--undo 取消；需 --execute 才会真的发出）',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
        { name: 'note', required: true, positional: true, help: 'Full note URL with xsec_token, or note id' },
        { name: 'comment', required: true, positional: true, help: 'Comment id' },
        { name: 'undo', type: 'boolean', default: false, help: 'Remove the like instead' },
        { name: 'execute', type: 'boolean', help: 'Actually send it' },
    ],
    columns: ['status', 'action', 'comment_id', 'note_id'],
    func: async (page, kwargs) => {
        const { noteId } = resolveNoteTarget(kwargs.note, LABEL);
        const commentId = String(kwargs.comment ?? '').trim();
        if (!XHS_HEX_ID_RE.test(commentId)) throw new ArgumentError(`${LABEL}: comment id must be a 24-character hex id`);
        const action = kwargs.undo ? 'unlike' : 'like';
        if (!kwargs.execute) return [{ status: 'dry-run', action, comment_id: commentId, note_id: noteId }];
        if (!page || typeof page.evaluateOnce !== 'function') throw new CommandExecutionError(`${LABEL} requires a runtime with evaluateOnce support`);
        await openXhsWorkspace(page);
        const r = unwrapEvaluateResult(await page.evaluateOnce(buildLikeScript({ noteId, commentId, undo: !!kwargs.undo })));
        if (!r || typeof r.ok !== 'boolean') throw new CommandExecutionError(`${LABEL}: malformed payload`);
        if (!r.ok) throw new CommandExecutionError(`${LABEL} failed: ${r.message ?? r.reason}${r.code != null ? ` (code ${r.code})` : ''}`);
        return [{ status: 'success', action, comment_id: commentId, note_id: noteId }];
    },
});

export const __test__ = { buildLikeScript };
