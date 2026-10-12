import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { SAVE_PATH, localImagesOf, orderIdOf, probeReviewForm, productCommentBody, readReviewForm, textLength, uploadImages } from './review-utils.js';

const LABEL = 'jd submit-review';

cli({
  site: 'jd',
  name: 'submit-review',
  access: 'write',
  description: '提交一条京东商品评价；不带 --confirm 只预演，不发请求',
  example: 'opencli jd submit-review 123456789012 --score 5 --content "质量不错" --confirm',
  domain: 'club.jd.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'order', positional: true, required: true, help: '订单号' },
    { name: 'score', type: 'int', required: true, help: '评分 1–5' },
    { name: 'content', type: 'string', required: true, help: '评价内容（约 500 个汉字以内）' },
    { name: 'sku', type: 'string', default: '', help: '商品编号；订单里只有一件待评价商品时可省略' },
    { name: 'images', type: 'string', default: '', help: '晒图：本地图片路径，逗号分隔，最多 9 张（jpg/png/gif/bmp，单张不超过 4MB）' },
    { name: 'public', type: 'bool', default: false, help: '公开昵称评价（默认匿名，与页面默认一致）' },
    { name: 'confirm', type: 'bool', default: false, help: '真正提交；缺省为预演' },
  ],
  columns: ['status', 'orderId', 'sku', 'product', 'score', 'anonymous', 'content', 'images', 'verified'],
  func: async (page, kwargs) => {
    const orderId = orderIdOf(kwargs.order);
    const score = Number(kwargs.score);
    if (!Number.isInteger(score) || score < 1 || score > 5) throw new ArgumentError('score must be an integer between 1 and 5');
    const content = typeof kwargs.content === 'string' ? kwargs.content : '';
    if (!content.trim()) throw new ArgumentError('content must not be empty');
    if (textLength(content) > 500) throw new ArgumentError('content is longer than the JD form allows (about 500 Chinese characters)');
    const wantedSku = String(kwargs.sku ?? '').trim();
    if (wantedSku && !/^\d{4,24}$/.test(wantedSku)) throw new ArgumentError('sku must be a numeric JD product id');
    const anonymous = !kwargs.public;
    const files = localImagesOf(kwargs.images);

    const form = await readReviewForm(page, orderId, LABEL);
    if (!form.goods.length) throw new CommandExecutionError(`${LABEL}: this order has no product awaiting review`);
    if (!wantedSku && form.goods.length > 1) {
      throw new ArgumentError(`order ${orderId} has ${form.goods.length} products awaiting review; pass --sku`, `opencli jd review-form ${orderId}`);
    }
    const target = wantedSku ? form.goods.find((g) => g.skuId === wantedSku) : form.goods[0];
    if (!target) throw new CommandExecutionError(`${LABEL}: sku ${wantedSku} is not awaiting review in order ${orderId}`);
    if (target.needsTags) {
      throw new CommandExecutionError(`${LABEL}: the form for sku ${target.skuId} requires tag choices, which this command cannot supply`, 'Nothing was submitted; review this product in the browser');
    }

    const row = { status: 'dry-run', orderId, sku: target.skuId, product: target.title, score, anonymous, content, images: files.length, verified: '' };
    // A dry run checks the files locally but uploads nothing: the upload itself stores pictures on JD.
    if (!kwargs.confirm) return [row];

    const imageUrls = files.length ? await uploadImages(page, target.skuId, files, LABEL) : [];

    // The browser tab is on this order's form page, so this is the same same-origin POST the page script sends.
    const reply = await page.evaluate(async (path, body) => {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json, text/javascript, */*; q=0.01',
        },
        body,
      });
      return { httpStatus: response.status, raw: (await response.text()).slice(0, 65536) };
    }, SAVE_PATH, productCommentBody({ orderId, sku: target.skuId, score, content, anonymous, imageUrls }));

    let saved = null;
    try { saved = JSON.parse(reply?.raw ?? ''); } catch { /* handled below */ }
    if (reply?.httpStatus !== 200 || !saved || typeof saved !== 'object' || typeof saved.success !== 'boolean') {
      const httpStatus = Number.isInteger(reply?.httpStatus) ? `HTTP ${reply.httpStatus}` : 'no HTTP status';
      throw new CommandExecutionError(
        `${LABEL}: the request was sent but JD's reply was not recognized (${httpStatus})`,
        'Check in the browser whether the product is already reviewed before trying again',
      );
    }
    if (!saved.success) {
      const code = String(saved.resultCode ?? '').replace(/[^\w-]/g, '').slice(0, 12);
      const reason = typeof saved.error === 'string' ? saved.error.replace(/[\x00-\x1f<>]/g, '').slice(0, 120) : '';
      throw new CommandExecutionError(`${LABEL}: JD did not accept the review${code ? ` (code ${code})` : ''}${reason ? `: ${reason}` : ''}`);
    }

    // JD's success flag and the page state are separate evidence. Re-read the form from the server (not the
    // already-loaded tab) a few times before reporting "no".
    // The review is already saved at this point: a failed re-read must not turn into a command failure.
    let verified = 'no';
    for (let attempt = 0; attempt < 3 && verified === 'no'; attempt++) {
      await page.wait({ time: 4 }); // fixed sleep; page.wait(n) returns as soon as the DOM is stable
      try {
        const after = await probeReviewForm(page, orderId, LABEL, { fresh: true });
        if (!after) verified = 'unknown';
        else if (!after.goods.some((g) => g.skuId === target.skuId)) verified = 'yes';
      } catch {
        verified = 'unknown';
      }
    }
    return [{ ...row, status: 'submitted', verified }];
  },
});
