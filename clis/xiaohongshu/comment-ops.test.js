import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';

import { joinInbox, markReplied, normalizeComment, normalizeMention, signedNoteUrl, threadRows, toIsoTime, xsecTokenOf } from './comment-api.js';
import { __test__ as replyTest } from './reply.js';
import { __test__ as inboxTest } from './inbox.js';
import './comment-list.js';
import './comment-like.js';

const NOTE_ID = '6afe9583000000002b03dd96';
const NOTE_URL = `https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=ABC%3D&xsec_source=pc_feed`;
const ME = '693bd5ef000000003700bf25';

// Shapes taken from a live /comment/page response (2026-11-20), trimmed.
const user = (userId, nickname, extra = {}) => ({ userId, nickname, aiAgent: false, ...extra });
const top = (id, uid, name, content, time, subs = [], extra = {}) => ({
    id, content, createTime: time, likeCount: '0', ipLocation: '湖南', showTags: [], subCommentCount: String(subs.length),
    userInfo: user(uid, name), subComments: subs, ...extra,
});
const sub = (id, uid, name, content, time, targetId, targetName, tags = []) => ({
    id, content, createTime: time, likeCount: '1', showTags: tags, userInfo: user(uid, name),
    targetComment: { id: targetId, userInfo: user('x', targetName) },
});

function liveThread() {
    return [
        { root: '', c: top('a1', 'u1', '皮卡丘', '国区搜不到', 1000) },
        { root: 'a1', c: sub('a2', ME, 'NSObject', 'tf版本', 2000, 'a1', '皮卡丘', ['is_author']) },
        { root: 'a1', c: sub('a3', 'u2', '破🔥', '怎么下', 3000, 'a2', 'NSObject') },
        { root: '', c: top('b1', 'u3', '博文何其多', '合盖能连吗', 1500) },
        { root: '', c: top('c1', 'u4', '点点', '收到', 1600, [], { userInfo: user('u4', '点点', { aiAgent: true }) }) },
        { root: '', c: top('d1', 'u5', 'allen', '第一问', 1000) },
        { root: 'd1', c: sub('d2', 'u5', 'allen', '追问', 1100, 'd1', 'allen') },
        { root: 'd1', c: sub('d3', ME, 'NSObject', '答', 1200, 'd2', 'allen') },
    ];
}

describe('comment-api helpers', () => {
    it('normalises camelCase and snake_case comments alike', () => {
        const camel = normalizeComment(sub('s1', ME, 'NSObject', 'hi', 1795070886000, 'r1', '皮卡丘', ['is_author']), 'r1');
        expect(camel).toMatchObject({ comment_id: 's1', root_id: 'r1', reply_to_id: 'r1', reply_to_user: '皮卡丘', user_id: ME, is_author: true, likes: 1 });
        expect(camel.time).toBe('2026-11-19T06:48:06.000Z');
        const snake = normalizeComment({ id: 't1', content: 'x', like_count: 3, create_time: 1795070886000, user_info: { user_id: 'u9', nickname: 'n' }, sub_comment_count: '2' });
        expect(snake).toMatchObject({ comment_id: 't1', root_id: '', reply_to_id: '', user_id: 'u9', likes: 3, replies: 2 });
    });

    it('marks what the viewer has and has not answered', () => {
        const rows = markReplied(threadRows(liveThread()), ME);
        const by = Object.fromEntries(rows.map(r => [r.comment_id, r.replied]));
        expect(by).toEqual({
            a1: true, // answered directly
            a2: null, // the viewer's own comment
            a3: false, // follow-up question, still open
            b1: false,
            c1: null, // AI agent
            d1: true, // the same person's later follow-up was answered
            d2: true,
            d3: null,
        });
    });

    it('de-duplicates rows by id', () => {
        const items = liveThread();
        expect(threadRows([...items, items[0]])).toHaveLength(items.length);
    });

    it('flattens a /you/mentions message into an actionable row', () => {
        const row = normalizeMention({
            id: '7709928612015800285', type: 'comment/item', title: '评论了你的笔记', time: 1795107641,
            commentInfo: { id: '6aff2b27000000003502b28a', content: '无敌好用' },
            itemInfo: { id: NOTE_ID, content: 'Ferry 正式上架 App Store', xsecToken: 'LBH=' },
            userInfo: { userid: '5f4279bc0000000001008f61', nickname: '。' },
        });
        expect(row).toMatchObject({ kind: 'comment', user: '。', comment_id: '6aff2b27000000003502b28a', note_id: NOTE_ID, note: 'Ferry 正式上架 App Store' });
        expect(row.note_url).toBe(`https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=LBH%3D&xsec_source=pc_notice`);
        expect(xsecTokenOf(row.note_url)).toBe('LBH=');
    });

    it('handles epoch seconds and milliseconds', () => {
        expect(toIsoTime(1795107641)).toBe(toIsoTime(1795107641000));
        expect(toIsoTime(0)).toBe('');
        expect(signedNoteUrl(NOTE_ID, '')).toBe('');
    });
});

describe('xiaohongshu reply', () => {
    const cmd = () => getRegistry().get('xiaohongshu/reply');
    const thread = { ok: true, viewerId: ME, items: liveThread() };
    const makePage = (...results) => ({
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn(async () => results.shift()),
        evaluateOnce: vi.fn(async () => results.shift()),
    });
    const A3 = '6aff0c00000000003003c9cb';
    const threadWith = (id) => ({ ...thread, items: thread.items.map(i => (i.c.id === 'a3' ? { ...i, c: { ...i.c, id } } : i)) });

    it('dry-runs by default: resolves the target and writes nothing', async () => {
        const page = makePage(threadWith(A3));
        const [row] = await cmd().func(page, { note: NOTE_URL, comment: A3, text: '最低 iOS 17' });
        expect(row).toMatchObject({ status: 'dry-run', target_author: '破🔥', target_text: '怎么下' });
        expect(page.evaluateOnce).not.toHaveBeenCalled();
    });

    it('posts once with target_comment_id when --execute', async () => {
        const page = makePage(threadWith(A3), { ok: true, comment_id: 'new1' });
        const [row] = await cmd().func(page, { note: NOTE_URL, comment: A3, text: '最低 iOS 17', execute: true });
        expect(row).toMatchObject({ status: 'success', comment_id: 'new1' });
        expect(page.evaluateOnce).toHaveBeenCalledTimes(1);
        expect(page.evaluateOnce.mock.calls[0][0]).toContain(`"target_comment_id"`.slice(1, -1));
        expect(page.evaluateOnce.mock.calls[0][0]).toContain(A3);
    });

    it('refuses a target id that is not in the thread', async () => {
        const page = makePage(thread);
        const [row] = await cmd().func(page, { note: NOTE_URL, comment: 'ffffffffffffffffffffffff', text: 'x', execute: true });
        expect(row.status).toBe('target-not-found');
        expect(page.evaluateOnce).not.toHaveBeenCalled();
    });

    it('does not post the same text twice under one target', async () => {
        const dup = threadWith(A3);
        dup.items = [...dup.items, { root: 'a1', c: sub('z9', ME, 'NSObject', '回复 破🔥 : 最低 iOS 17', 4000, A3, '破🔥') }];
        const page = makePage(dup);
        const [row] = await cmd().func(page, { note: NOTE_URL, comment: A3, text: '最低 iOS 17', execute: true });
        expect(row.status).toBe('already-replied');
        expect(page.evaluateOnce).not.toHaveBeenCalled();
    });

    it('validates ids and text before touching the browser', () => {
        expect(() => replyTest.parseReplyJob({ note: NOTE_URL, comment_id: 'nope', text: 'x' })).toThrow(/24-character/);
        expect(() => replyTest.parseReplyJob({ note: NOTE_URL, comment_id: A3, text: '  ' })).toThrow(/empty/);
    });

    it('reads JSON and JSONL batch files', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-reply-'));
        const jsonl = path.join(dir, 'a.jsonl');
        fs.writeFileSync(jsonl, `${JSON.stringify({ note_url: NOTE_URL, comment_id: A3, text: 'a' })}\n${JSON.stringify({ note: NOTE_URL, comment: A3, text: 'b' })}\n`);
        expect(replyTest.readReplyJobs(jsonl).map(j => j.text)).toEqual(['a', 'b']);
        const json = path.join(dir, 'b.json');
        fs.writeFileSync(json, JSON.stringify([{ note_url: NOTE_URL, comment_id: A3, text: 'c' }]));
        expect(replyTest.readReplyJobs(json)).toHaveLength(1);
    });
});

describe('xiaohongshu inbox', () => {
    it('joins messages with thread state; missing comments are unknown', () => {
        const rows = markReplied(threadRows(liveThread()), ME);
        const threads = new Map([[NOTE_ID, { rows }]]);
        const joined = joinInbox([
            { note_id: NOTE_ID, comment_id: 'a3' },
            { note_id: NOTE_ID, comment_id: 'a1' },
            { note_id: NOTE_ID, comment_id: 'a3' },
            { note_id: NOTE_ID, comment_id: 'c1' },
            { note_id: NOTE_ID, comment_id: 'a2' },
            { note_id: NOTE_ID, comment_id: 'gone' },
            { note_id: 'other', comment_id: 'x' },
        ], threads);
        // duplicate a3, AI c1 and own a2 are dropped; unknown stays null
        expect(joined.map(r => [r.comment_id, r.replied])).toEqual([['a3', false], ['a1', true], ['gone', null], ['x', null]]);
        expect(joined[0].root_id).toBe('a1');
    });
});

describe('xiaohongshu comment-like', () => {
    it('dry-runs without --execute', async () => {
        const page = { goto: vi.fn(), evaluateOnce: vi.fn() };
        const [row] = await getRegistry().get('xiaohongshu/comment-like').func(page, { note: NOTE_URL, comment: '6aff0c00000000003003c9cb' });
        expect(row).toMatchObject({ status: 'dry-run', action: 'like' });
        expect(page.goto).not.toHaveBeenCalled();
    });
});
