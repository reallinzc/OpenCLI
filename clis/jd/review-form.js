import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';
import { orderIdOf, readReviewForm } from './review-utils.js';

const LABEL = 'jd review-form';

cli({
  site: 'jd',
  name: 'review-form',
  access: 'read',
  description: '京东某个订单评价表单里待评价的商品（含商品编号）',
  example: 'opencli jd review-form 123456789012 -f json',
  domain: 'club.jd.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'order', positional: true, required: true, help: '订单号' },
  ],
  columns: ['orderId', 'sku', 'product', 'requiresTags', 'anonymousByDefault'],
  func: async (page, kwargs) => {
    const orderId = orderIdOf(kwargs.order);
    const form = await readReviewForm(page, orderId, LABEL);
    if (!form.goods.length) throw new EmptyResultError(LABEL, '该订单的评价表单里没有待评价的商品');
    return form.goods.map((g) => ({
      orderId,
      sku: g.skuId,
      product: g.title,
      requiresTags: g.needsTags,
      anonymousByDefault: form.anonymousChecked,
    }));
  },
});
