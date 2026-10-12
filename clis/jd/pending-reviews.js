import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { BASE, openClubPage } from './review-utils.js';

const LABEL = 'jd pending-reviews';

cli({
  site: 'jd',
  name: 'pending-reviews',
  access: 'read',
  description: '京东待评价订单（每件商品一行，每页 20 个订单）',
  example: 'opencli jd pending-reviews -f json',
  domain: 'club.jd.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'page', type: 'int', default: 1, help: '页码' },
  ],
  columns: ['orderId', 'orderedAt', 'product', 'quantity', 'pendingOrders'],
  func: async (page, kwargs) => {
    const pageNo = Number(kwargs.page ?? 1);
    if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > 200) throw new ArgumentError('page must be an integer between 1 and 200');

    await openClubPage(page, `${BASE}/myJdcomment.action?sort=0&page=${pageNo}`, LABEL);
    const listing = await page.evaluate(() => {
      const table = document.querySelector('table.order-tb');
      const totalText = (document.querySelector('.ui-page .text')?.textContent ?? '').match(/共\s*(\d+)\s*个订单/);
      return {
        hasTable: !!table,
        totalCount: totalText ? Number(totalText[1]) : null,
        blocks: [...(table?.querySelectorAll('tbody') ?? [])].map((tb) => ({
          orderNo: (tb.querySelector('.number a')?.textContent ?? '').trim(),
          dealTime: (tb.querySelector('.dealtime')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
          goods: [...tb.querySelectorAll('.goods-item')].map((item) => ({
            title: (item.querySelector('.p-name a')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
            count: ((item.parentElement?.querySelector('.goods-number')?.textContent ?? '').match(/\d+/) || [])[0] ?? '',
          })),
        })),
      };
    });

    // An unrecognized page must not read as "nothing to review".
    if (!listing?.hasTable) {
      if (listing?.totalCount === 0) throw new EmptyResultError(LABEL, '没有待评价订单');
      throw new CommandExecutionError(`${LABEL}: page structure not recognized`, 'JD may have changed the page');
    }
    const rows = [];
    for (const block of listing.blocks) {
      if (!/^\d{6,24}$/.test(block.orderNo) || !block.goods.length || block.goods.some((g) => !g.title || !/^\d+$/.test(g.count))) {
        throw new CommandExecutionError(`${LABEL}: an order row was not recognized`, 'JD may have changed the page');
      }
      for (const g of block.goods) {
        rows.push({ orderId: block.orderNo, orderedAt: block.dealTime, product: g.title, quantity: Number(g.count), pendingOrders: listing.totalCount });
      }
    }
    if (!rows.length) throw new EmptyResultError(LABEL, pageNo > 1 ? `第 ${pageNo} 页没有订单` : '没有待评价订单');
    return rows;
  },
});
