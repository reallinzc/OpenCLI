/**
 * Xiaohongshu private messages (私信): dm-list / dm-read. Reads go through the
 * page's IM SDK (see dm-api.js); sending is dm-send.js.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { CHAT_URL, buildDmChatsScript, buildDmThreadScript, dmMessageRows, normalizeDmChat, resolveDmUser } from './dm-api.js';
import { unwrapEvaluateResult } from './shared.js';
import { jitterSeconds } from './risk-control.js';

export function requireOk(result, label) {
    const r = unwrapEvaluateResult(result);
    if (!r || typeof r !== 'object') throw new CommandExecutionError(`${label}: malformed payload`);
    if (!r.ok) {
        if (r.reason === 'login_wall') throw new AuthRequiredError('www.xiaohongshu.com');
        if (r.reason === 'api_unavailable') {
            throw new CommandExecutionError(`${label}: the page's IM SDK is unreachable; the site bundle may have changed.`);
        }
        throw new CommandExecutionError(`${label} failed: ${r.message ?? r.reason}${r.code != null ? ` (code ${r.code})` : ''}`);
    }
    return r;
}

export async function openChat(page, url) {
    await page.goto(url);
    await page.wait({ time: jitterSeconds(3, 5) });
}

cli({
    site: 'xiaohongshu',
    name: 'dm-list',
    access: 'read',
    description: '小红书私信会话列表：对方、最后一条消息、最后是谁发的、未读数（--waiting 只看等你回的）',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
        { name: 'limit', type: 'int', default: 20, help: 'Conversations to read (newest first)' },
        { name: 'waiting', type: 'boolean', default: false, help: 'Only conversations whose last message is theirs' },
        { name: 'timeout', type: 'int', default: 300, help: 'Time limit in seconds' },
    ],
    columns: ['rank', 'user', 'last_message', 'last_from', 'last_time', 'unread', 'follow', 'user_id'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('Browser session required for xiaohongshu dm-list');
        await openChat(page, CHAT_URL);
        const r = requireOk(await page.evaluate(buildDmChatsScript({
            limit: Math.max(1, Number(kwargs.limit) || 20), withLast: true,
        })), 'xiaohongshu/dm-list');
        let rows = r.chats.map(c => normalizeDmChat(c, r.unread, r.viewerId));
        if (kwargs.waiting) rows = rows.filter(row => row.last_from === 'them');
        return rows.map((row, i) => ({ rank: i + 1, ...row }));
    },
});

cli({
    site: 'xiaohongshu',
    name: 'dm-read',
    access: 'read',
    description: '读一个人的私信记录（旧到新）',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
        { name: 'user', required: true, positional: true, help: 'User id, profile URL or /chat?openUid= URL' },
        { name: 'limit', type: 'int', default: 20, help: 'Newest N messages' },
    ],
    columns: ['time', 'from', 'type', 'text', 'message_id'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('Browser session required for xiaohongshu dm-read');
        const userId = resolveDmUser(kwargs.user, 'xiaohongshu/dm-read');
        await openChat(page, CHAT_URL);
        const r = requireOk(await page.evaluate(buildDmThreadScript(userId, Math.max(1, Number(kwargs.limit) || 20))), 'xiaohongshu/dm-read');
        return dmMessageRows(r.messages, r.viewerId);
    },
});

export const __test__ = { requireOk };
