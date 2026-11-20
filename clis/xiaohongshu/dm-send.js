/**
 * Xiaohongshu dm-send — send a private message (私信) by typing into the real
 * chat box of /chat?openUid=<user> and pressing Enter once, then reading the
 * conversation back to confirm. That is the path a person's message takes, so
 * the long-link / HTTP fallback and the outgoing-message model stay the page's
 * business (see dm-api.js).
 *
 * Safety rules:
 *   - Without --execute nothing is typed; the conversation is read and shown.
 *   - The exact same text already sent to this user is not sent again (a
 *     re-run after a timeout must not double-send).
 *   - A stranger who has not answered gets no second message
 *     (`stranger-limit`); the platform limits those and pushing it is the
 *     kind of thing risk control notices.
 *   - The chat box must be empty before typing and must hold exactly the
 *     message after typing; otherwise it is cleared and nothing is sent.
 *   - Enter is pressed once; a send that cannot be confirmed is reported as
 *     `sent-unverified`, never retried.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
    CHAT_EDITOR_SELECTOR, buildDmThreadScript, buildEditorStateScript, chatUrlFor,
    dmMessageRows, dmSendDecision, resolveDmUser, splitDmLines, __test__ as dmApiTest,
} from './dm-api.js';
import { openChat, requireOk } from './dm.js';
import { unwrapEvaluateResult } from './shared.js';

const SEND_LABEL = 'xiaohongshu/dm-send';

/** Read the conversation, then (when `execute`) type and send once. Returns one row. */
export async function sendDmOnce(page, { userId, text }, { execute, confirmSeconds = 10 }) {
    await openChat(page, chatUrlFor(userId));
    const before = requireOk(await page.evaluate(buildDmThreadScript(userId, 30)), SEND_LABEL);
    const rows = dmMessageRows(before.messages, before.viewerId);
    const user = before.info?.nickname ?? before.info?.userName ?? '';
    const decision = dmSendDecision({ info: before.info, rows, text });
    const base = { user, user_id: userId, text, message_id: null, detail: decision.detail };
    if (decision.status !== 'ok') return { ...base, status: decision.status };
    if (!execute) return { ...base, status: 'dry-run' };

    const editor = async (action) => {
        const s = unwrapEvaluateResult(await page.evaluate(buildEditorStateScript(action)));
        if (!s?.ok) throw new CommandExecutionError(`${SEND_LABEL}: chat box not found on ${chatUrlFor(userId)}; the page layout may have changed. Nothing was sent.`);
        return s;
    };
    const squash = dmApiTest.squash;
    if (squash((await editor('read')).text)) {
        await editor('clear');
        if (squash((await editor('read')).text)) {
            throw new CommandExecutionError(`${SEND_LABEL}: the chat box already holds a draft that could not be cleared. Nothing was sent.`);
        }
    }
    await page.click(CHAT_EDITOR_SELECTOR);
    const lines = splitDmLines(text);
    for (const [i, line] of lines.entries()) {
        if (i > 0) await page.pressKey('Shift+Enter');
        if (line) await page.insertText(line);
    }
    const typed = (await editor('read')).text;
    if (squash(typed) !== squash(text)) {
        await editor('clear');
        throw new CommandExecutionError(`${SEND_LABEL}: the chat box holds "${typed}" instead of the message; cleared it. Nothing was sent.`);
    }
    await page.pressKey('Enter');

    const deadline = Date.now() + confirmSeconds * 1000;
    let toast = [];
    while (Date.now() < deadline) {
        await page.wait({ time: 2 });
        const after = unwrapEvaluateResult(await page.evaluate(buildDmThreadScript(userId, 10)));
        const sent = after?.ok ? dmMessageRows(after.messages, after.viewerId)
            .find(r => r.from === 'me' && squash(r.text) === squash(text) && !rows.some(old => old.message_id === r.message_id)) : null;
        if (sent) return { ...base, status: 'sent', message_id: sent.message_id, detail: '' };
        toast = (await editor('read')).toast ?? [];
    }
    return { ...base, status: 'sent-unverified', detail: toast.length ? `page says: ${toast.join(' / ')}` : 'Enter was pressed once; the message did not show up in the history yet' };
}

cli({
    site: 'xiaohongshu',
    name: 'dm-send',
    access: 'write',
    description: '给小红书用户发私信（在真实聊天框里输入并发送；不加 --execute 只读会话、不发出；同文不重发；陌生人未回复不发第二条）',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
        { name: 'user', required: true, positional: true, help: 'User id, profile URL or /chat?openUid= URL' },
        { name: 'text', required: true, positional: true, help: 'Message text (newlines become line breaks)' },
        { name: 'execute', type: 'boolean', help: 'Actually send the message' },
    ],
    columns: ['status', 'user', 'text', 'message_id', 'detail', 'user_id'],
    func: async (page, kwargs) => {
        const userId = resolveDmUser(kwargs.user, SEND_LABEL);
        const text = String(kwargs.text ?? '').trim();
        if (!text) throw new ArgumentError(`${SEND_LABEL}: message text cannot be empty`);
        if (!page) throw new CommandExecutionError('Browser session required for xiaohongshu dm-send');
        for (const fn of ['click', 'insertText', 'pressKey']) {
            if (typeof page[fn] !== 'function') throw new CommandExecutionError(`${SEND_LABEL} requires a runtime with ${fn} support`);
        }
        return [await sendDmOnce(page, { userId, text }, { execute: !!kwargs.execute })];
    },
});

export const __test__ = { sendDmOnce };
