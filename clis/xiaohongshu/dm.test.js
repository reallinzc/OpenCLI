import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';

import { chatUrlFor, dmMessageRows, dmSendDecision, normalizeDmChat, normalizeDmMessage, resolveDmUser, splitDmLines } from './dm-api.js';
import { __test__ as dmTest } from './dm-send.js';
import './dm.js';

const ME = '693bd5ef000000003700bf25';
const THEM = '64bd406b0000000014035615';

// Shapes taken from live /api/im/web/messages/history and /v3/chats (2026-11-20), trimmed.
const msg = (id, sender, content, contentType, createdAt, extra = {}) => ({
    id, senderId: sender, receiverId: sender === ME ? THEM : ME, createdAt, revoked: false,
    content: JSON.stringify({ content, content_type: contentType, front_chain: contentType === 1 ? content : '[分享评论] 怎么下' }),
    ...extra,
});

describe('dm-api helpers', () => {
    it('accepts ids, profile URLs and chat URLs', () => {
        expect(resolveDmUser(THEM, 't')).toBe(THEM);
        expect(resolveDmUser(`https://www.xiaohongshu.com/user/profile/${THEM}?xsec_token=x`, 't')).toBe(THEM);
        expect(resolveDmUser(`https://www.xiaohongshu.com/chat?openUid=${THEM}`, 't')).toBe(THEM);
        expect(() => resolveDmUser('社长家', 't')).toThrow(/24-character/);
        expect(() => resolveDmUser(`https://example.com/user/profile/${THEM}`, 't')).toThrow();
        expect(chatUrlFor(THEM)).toBe(`https://www.xiaohongshu.com/chat?openUid=${THEM}`);
    });

    it('turns history entries into rows, oldest first', () => {
        const rows = dmMessageRows([
            msg('m3', THEM, '连上电脑就黑了', 1, 1795075020000),
            msg('m2', ME, 'https://testflight.apple.com/join/UtcTPJ5E', 1, 1795074660000),
            msg('m1', ME, '{"type":"comment"}', 3, 1795074650000),
        ], ME);
        expect(rows.map(r => [r.message_id, r.from, r.type])).toEqual([['m1', 'me', 'card'], ['m2', 'me', 'text'], ['m3', 'them', 'text']]);
        expect(rows[0].text).toBe('[分享评论] 怎么下');
        expect(rows[2].time).toBe('2026-11-19T07:57:00.000Z');
        expect(normalizeDmMessage(msg('r', THEM, 'x', 1, 1, { revoked: true }), ME)).toMatchObject({ type: 'revoked', text: '[已撤回]' });
    });

    it('summarises a conversation with who spoke last', () => {
        const row = normalizeDmChat({
            chatUserId: THEM, lastMsgContent: 'x', lastMsgTime: 1795105386000, info: { nickname: '社长家', followStatus: 'NONE' },
            __last: msg('m', THEM, '鼠标右键不能用', 1, 1795105386000),
        }, { [THEM]: 2 }, ME);
        expect(row).toEqual({ user: '社长家', user_id: THEM, last_message: '鼠标右键不能用', last_from: 'them', last_time: "2026-11-19T16:23:06.000Z", unread: 2, follow: 'NONE' });
    });

    it('refuses duplicates, a second unanswered message to a stranger, and blocked users', () => {
        const mine = [{ from: 'me', text: 'TF 链接：https://x' }];
        expect(dmSendDecision({ info: {}, rows: mine, text: 'TF  链接：https://x ' }).status).toBe('already-sent');
        expect(dmSendDecision({ info: { showStrangerLimitHint: true }, rows: mine, text: '再问一下' }).status).toBe('stranger-limit');
        expect(dmSendDecision({ info: { showStrangerLimitHint: true }, rows: [...mine, { from: 'them', text: '好' }], text: '再问一下' }).status).toBe('ok');
        expect(dmSendDecision({ info: { showStrangerLimitHint: true }, rows: [], text: '你好' }).status).toBe('ok');
        expect(dmSendDecision({ info: { isBlock: true }, rows: [], text: '你好' }).status).toBe('blocked');
        expect(splitDmLines('a\r\nb\nc')).toEqual(['a', 'b', 'c']);
    });
});

/**
 * A page whose chat box behaves like the real one: insertText appends,
 * Shift+Enter adds a line, Enter "sends" (the message shows up in history).
 */
function fakeChat({ history = [], info = { nickname: '社长家', showStrangerLimitHint: true }, draft = '', mangle = false, deliver = true } = {}) {
    const state = { history: [...history], box: draft };
    const page = {
        goto: vi.fn(async () => {}),
        wait: vi.fn(async () => {}),
        click: vi.fn(async () => ({ matches_n: 1 })),
        insertText: vi.fn(async (t) => { state.box += mangle ? t.slice(1) : t; }),
        pressKey: vi.fn(async (k) => {
            if (k === 'Shift+Enter') state.box += '\n';
            if (k === 'Enter') {
                if (deliver) state.history.unshift(msg(`sent${state.history.length}`, ME, state.box, 1, Date.now()));
                state.box = '';
            }
        }),
        evaluate: vi.fn(async (js) => {
            if (js.includes('getChatInfoV3')) return { ok: true, viewerId: ME, info, messages: state.history };
            if (js.includes(`"clear" === 'clear'`)) state.box = '';
            return { ok: true, text: state.box, toast: [] };
        }),
    };
    return { page, state };
}

describe('dm-send', () => {
    const send = (page, text, execute) => dmTest.sendDmOnce(page, { userId: THEM, text }, { execute, confirmSeconds: 1 });

    it('dry-run reads the conversation and types nothing', async () => {
        const { page } = fakeChat();
        const row = await send(page, '你好', false);
        expect(row).toMatchObject({ status: 'dry-run', user: '社长家', user_id: THEM });
        expect(page.goto).toHaveBeenCalledWith(chatUrlFor(THEM));
        expect(page.insertText).not.toHaveBeenCalled();
        expect(page.pressKey).not.toHaveBeenCalled();
    });

    it('types line by line, presses Enter once and confirms from history', async () => {
        const { page, state } = fakeChat();
        const row = await send(page, '链接在这：https://x\n先装 TestFlight', true);
        expect(page.insertText.mock.calls.map(c => c[0])).toEqual(['链接在这：https://x', '先装 TestFlight']);
        expect(page.pressKey.mock.calls.map(c => c[0])).toEqual(['Shift+Enter', 'Enter']);
        expect(row).toMatchObject({ status: 'sent', message_id: 'sent0' });
        expect(state.history).toHaveLength(1);
    });

    it('does not send a second unanswered message to a stranger, nor the same text twice', async () => {
        const { page } = fakeChat({ history: [msg('m1', ME, '第一条', 1, 1)] });
        expect((await send(page, '第二条', true)).status).toBe('stranger-limit');
        expect((await send(page, '第一条', true)).status).toBe('already-sent');
        expect(page.insertText).not.toHaveBeenCalled();
    });

    it('clears the box and sends nothing when what got typed is not the message', async () => {
        const { page, state } = fakeChat({ mangle: true });
        await expect(send(page, '你好', true)).rejects.toThrow(/Nothing was sent/);
        expect(page.pressKey).not.toHaveBeenCalledWith('Enter');
        expect(state.box).toBe('');
    });

    it('reports sent-unverified instead of retrying when the message never shows up', async () => {
        const { page } = fakeChat({ deliver: false });
        const row = await send(page, '你好', true);
        expect(row.status).toBe('sent-unverified');
        expect(page.pressKey.mock.calls.filter(c => c[0] === 'Enter')).toHaveLength(1);
    });

    it('is registered with dry-run by default', () => {
        const cmd = getRegistry().get('xiaohongshu/dm-send');
        expect(cmd.access).toBe('write');
        expect(cmd.args.find(a => a.name === 'execute').default).toBeUndefined();
        expect(getRegistry().get('xiaohongshu/dm-list').columns).toContain('last_from');
    });
});
