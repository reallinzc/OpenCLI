/**
 * Xiaohongshu reply / reply-batch — answer a specific comment (楼中楼) by id.
 *
 * `comment` only posts top-level comments. The comment-post API takes a
 * `target_comment_id`; with it the post lands under that comment and its
 * author gets a "回复了你的评论" notification — what the page's own 回复
 * button does.
 *
 * Safety rules (both commands):
 *   - Without --execute nothing is written; the target is resolved and shown.
 *   - The target id must exist in the note's thread (read first), so a stale
 *     or mistyped id never turns into a misplaced reply.
 *   - If you already posted the exact same text under that target, it is not
 *     posted again (a re-run after a timeout must not double-post).
 *   - Every write is sent exactly once; a failure is reported, never retried.
 *   - reply-batch spaces writes 30–60 s apart and stops at the first write
 *     the API rejects (rate limiting tends to escalate if pushed).
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { API_PRELUDE_JS, ENDPOINTS, parseReplyJob, readReplyJobs, threadRows, writeSpacingSeconds, xsecTokenOf } from './comment-api.js';
import { buildThreadScript, openXhsWorkspace, requireThread } from './comment-list.js';
import { unwrapEvaluateResult } from './shared.js';

const LABEL = 'xiaohongshu/reply';

export function buildPostReplyScript({ noteId, commentId, content }) {
    return `
(async () => {
  ${API_PRELUDE_JS}
  const post = __xhsApi(${JSON.stringify(ENDPOINTS.commentPost)}, '.post(');
  if (!post) return { ok: false, reason: 'api_unavailable' };
  try {
    const d = __xhsBody(await post({
      note_id: ${JSON.stringify(noteId)},
      content: ${JSON.stringify(content)},
      target_comment_id: ${JSON.stringify(commentId)},
      at_users: [],
    }));
    const c = (d.comment && typeof d.comment === 'object') ? d.comment : {};
    return { ok: true, comment_id: typeof c.id === 'string' ? c.id : null };
  } catch (err) {
    return __xhsErr(err);
  }
})()
`;
}


/**
 * Resolve the target inside the note's thread and post (when `execute`).
 * Returns one output row. Throws only for conditions that should stop a batch.
 */
export async function replyOnce(page, job, { execute }) {
    const thread = requireThread(await page.evaluate(buildThreadScript(job.noteId, xsecTokenOf(job.noteUrl), {
        stopAtId: job.commentId,
    })), LABEL);
    const rows = threadRows(thread.items);
    const target = rows.find(r => r.comment_id === job.commentId);
    const base = { note_id: job.noteId, target_id: job.commentId, target_author: target?.author ?? '', target_text: target?.text ?? '', text: job.text };
    if (!target) {
        return { ...base, status: 'target-not-found', comment_id: null };
    }
    const duplicate = rows.some(r => r.user_id === thread.viewerId && r.reply_to_id === job.commentId && r.text.replace(/^回复\s*[^:：]+\s*[:：]\s*/, '') === job.text);
    if (duplicate) {
        return { ...base, status: 'already-replied', comment_id: null };
    }
    if (!execute) {
        return { ...base, status: 'dry-run', comment_id: null };
    }
    const result = unwrapEvaluateResult(await page.evaluateOnce(buildPostReplyScript({
        noteId: job.noteId, commentId: job.commentId, content: job.text,
    })));
    if (!result || typeof result.ok !== 'boolean') throw new CommandExecutionError(`${LABEL}: malformed post payload`);
    if (!result.ok) {
        throw new CommandExecutionError(`${LABEL} rejected: ${result.message ?? result.reason}${result.code != null ? ` (code ${result.code})` : ''}`,
            'Nothing was retried. Wait a while before posting again.');
    }
    return { ...base, status: result.comment_id ? 'success' : 'posted-unverified', comment_id: result.comment_id };
}

const COLUMNS = ['status', 'target_author', 'target_text', 'text', 'comment_id', 'target_id', 'note_id'];

function requireRuntime(page, name) {
    if (!page) throw new CommandExecutionError(`Browser session required for xiaohongshu ${name}`);
    if (typeof page.evaluateOnce !== 'function') {
        throw new CommandExecutionError(`xiaohongshu ${name} requires a runtime with evaluateOnce support`);
    }
}

cli({
    site: 'xiaohongshu',
    name: 'reply',
    access: 'write',
    description: '回复小红书笔记下的某条评论（楼中楼；不加 --execute 只核对目标、不发出）',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
        { name: 'note', required: true, positional: true, help: 'Full note URL with xsec_token' },
        { name: 'comment', required: true, positional: true, help: 'Comment id to reply to (from comment-list / inbox)' },
        { name: 'text', required: true, positional: true, help: 'Reply text' },
        { name: 'execute', type: 'boolean', help: 'Actually post the reply' },
    ],
    columns: COLUMNS,
    func: async (page, kwargs) => {
        const job = parseReplyJob({ note: kwargs.note, comment_id: kwargs.comment, text: kwargs.text });
        requireRuntime(page, 'reply');
        await openXhsWorkspace(page);
        return [await replyOnce(page, job, { execute: !!kwargs.execute })];
    },
});


cli({
    site: 'xiaohongshu',
    name: 'reply-batch',
    access: 'write',
    description: '按文件批量回复评论（JSON / JSONL：note_url、comment_id、text；每条间隔 30–60 秒，被拒即停）',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
        { name: 'file', required: true, positional: true, help: 'JSON array or JSONL of { note_url, comment_id, text }' },
        { name: 'execute', type: 'boolean', help: 'Actually post the replies' },
        { name: 'min-gap', type: 'int', default: 30, help: 'Min seconds between posts' },
        { name: 'max-gap', type: 'int', default: 60, help: 'Max seconds between posts' },
    ],
    columns: COLUMNS,
    func: async (page, kwargs) => {
        const jobs = readReplyJobs(kwargs.file);
        requireRuntime(page, 'reply-batch');
        await openXhsWorkspace(page);
        const out = [];
        let posted = 0;
        for (const job of jobs) {
            if (posted > 0 && kwargs.execute) {
                await page.wait({ time: writeSpacingSeconds(Number(kwargs['min-gap'] ?? 30), Number(kwargs['max-gap'] ?? 60)) });
                // The extension reclaims an adapter tab left idle for ~30 s, after
                // which evaluate() fails with "stale page identity" (seen
                // 2026-11-20). goto() re-resolves a live tab, so re-open the
                // workspace after every pause.
                await openXhsWorkspace(page);
            }
            let row;
            try {
                row = await replyOnce(page, job, { execute: !!kwargs.execute });
            } catch (err) {
                out.push({ status: 'stopped', target_author: '', target_text: '', text: job.text, comment_id: null, target_id: job.commentId, note_id: job.noteId });
                process.stderr.write(`xiaohongshu/reply-batch: stopped after ${posted} posts: ${err.message}\n`);
                break;
            }
            out.push(row);
            if (row.status === 'success' || row.status === 'posted-unverified') posted++;
        }
        return out;
    },
});

export const __test__ = { buildPostReplyScript, parseReplyJob, readReplyJobs, replyOnce };
