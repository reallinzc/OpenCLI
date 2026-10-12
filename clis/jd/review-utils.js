// Shared by the jd review commands (pending-reviews, review-form, submit-review).
// Page structure and the save request were read on 2026-10-12 from the live club.jd.com pages and from
// JD's own page scripts under misc.360buyimg.com/user/myjd/comment/1.0.0/js/comment/
// (validateService.js builds the fields, submitService.js posts them).
import fs from 'node:fs';
import path from 'node:path';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

export const BASE = 'https://club.jd.com/myJdcomments';
export const SAVE_PATH = '/myJdcomments/saveProductComment.action';

export function orderIdOf(value) {
  const id = String(value ?? '').trim();
  if (!/^\d{6,24}$/.test(id)) throw new ArgumentError('order must be a numeric JD order number');
  return id;
}

// JD's own length rule (utils.getTextLength in its page script): two Latin-1 characters count as one.
export function textLength(s) {
  return Math.ceil((s.length + (s.match(/[^\x00-\xff]/g)?.length ?? 0)) / 2);
}

// Same fields, order and double encoding as the page script: it URI-encodes the text,
// then jQuery form-encodes the result again.
// With pictures the page script adds `imgs` (comma-joined image URLs) and sends saveStatus 2 instead of 1.
export function productCommentBody({ orderId, sku, score, content, anonymous, imageUrls = [] }) {
  const fields = { orderId, productId: sku, score: String(score), content: encodeURIComponent(content) };
  if (imageUrls.length) fields.imgs = imageUrls.join(',');
  fields.saveStatus = imageUrls.length ? '2' : '1';
  fields.anonymousFlag = anonymous ? '1' : '0';
  return new URLSearchParams(fields).toString();
}

// Limits of JD's own uploader on the review form (plupload settings read from the live page on 2026-10-12):
// at most 9 pictures per product, jpg/jpeg/gif/png/bmp, 4 MB each.
const IMAGE_TYPES = new Set(['.jpg', '.jpeg', '.gif', '.png', '.bmp']);
export const MAX_IMAGES = 9;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function localImagesOf(value) {
  const files = String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean).map((item) => path.resolve(item));
  if (files.length > MAX_IMAGES) throw new ArgumentError(`images: JD accepts at most ${MAX_IMAGES} pictures per product`);
  for (const file of files) {
    let stat;
    try { stat = fs.statSync(file); } catch { throw new ArgumentError(`images: file not found: ${file}`); }
    if (!stat.isFile()) throw new ArgumentError(`images: not a file: ${file}`);
    if (!IMAGE_TYPES.has(path.extname(file).toLowerCase())) throw new ArgumentError(`images: ${path.basename(file)} must be jpg, jpeg, gif, png or bmp`);
    if (stat.size > MAX_IMAGE_BYTES) throw new ArgumentError(`images: ${path.basename(file)} is larger than 4 MB`);
    if (stat.size === 0) throw new ArgumentError(`images: ${path.basename(file)} is empty`);
  }
  return files;
}

// page.setFileInput failed in the Chrome these commands were developed on: DOM.setFileInputFiles returned
// "-32000 Not allowed" (observed 2026-10-12 with extension 1.0.24), so the bytes go through the page instead.
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.png': 'image/png', '.bmp': 'image/bmp' };
// The OpenCLI daemon rejects a command larger than 1 MB, so each picture is handed over in base64 pieces.
const PIECE = 400 * 1024;

// Give the pictures to the form's own uploader and wait for it to finish. The files are rebuilt inside the page
// and placed on the form's file input; from its change event on, JD's page script does the upload to
// /myJdcomments/ajaxUploadImage.action and records each stored picture's URL on the thumbnail (`originalsrc`).
// Must be called while the tab is on that order's review form. Returns the URLs in upload order.
export async function uploadImages(page, sku, files, label) {
  const slot = `__jdReviewPictures${Date.now()}`;
  await page.evaluate((name) => { window[name] = []; }, slot);
  for (const [index, file] of files.entries()) {
    const encoded = fs.readFileSync(file).toString('base64');
    for (let offset = 0; offset < encoded.length; offset += PIECE) {
      await page.evaluate((name, at, piece) => { (window[name][at] ??= []).push(piece); }, slot, index, encoded.slice(offset, offset + PIECE));
    }
  }
  const handed = await page.evaluate((name, productSku, metas) => {
    const pieces = window[name];
    delete window[name];
    const input = document.querySelector(`.f-item.f-goods.product-${productSku} .plupload input[type=file]`);
    if (!input) return { accepted: -1 };
    const transfer = new DataTransfer();
    metas.forEach((meta, at) => {
      const binary = atob(pieces[at].join(''));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      transfer.items.add(new File([bytes], meta.fileName, { type: meta.mime }));
    });
    input.files = transfer.files;
    const accepted = input.files.length;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { accepted };
  }, slot, sku, files.map((file) => ({ fileName: path.basename(file), mime: MIME[path.extname(file).toLowerCase()] })));
  if (handed?.accepted !== files.length) {
    throw new CommandExecutionError(`${label}: the review form has no usable picture input for sku ${sku}; nothing was submitted`, 'JD may have changed the form');
  }
  let state = null;
  for (let waited = 0; waited < 90; waited++) {
    await page.wait({ time: 1 });
    state = await page.evaluate((productSku) => {
      const items = [...document.querySelectorAll(`.f-item.f-goods.product-${productSku} .thumbnail-item`)];
      return {
        shown: items.length,
        failed: items.filter((el) => el.classList.contains('thumbnail-error')).length,
        stored: items.map((el) => el.querySelector('img')?.getAttribute('originalsrc') ?? '').filter(Boolean),
      };
    }, sku);
    if (state?.failed) break;
    if (state?.stored?.length === files.length) break;
  }
  if (state?.failed) {
    throw new CommandExecutionError(
      `${label}: JD rejected ${state.failed} of ${files.length} pictures; nothing was submitted`,
      'JD accepts jpg/png/gif/bmp up to 4 MB and refuses pictures that contain a QR code',
    );
  }
  if (state?.stored?.length !== files.length || state.stored.some((url) => !/^\/\/img\d+\.360buyimg\.com\/shaidan\/jfs\//.test(url))) {
    throw new CommandExecutionError(`${label}: picture upload did not finish (${state?.stored?.length ?? 0} of ${files.length}); nothing was submitted`);
  }
  return state.stored;
}

// Open a club.jd.com page in the logged-in browser. Fail with a typed error if JD sent us elsewhere.
export async function openClubPage(page, url, label) {
  // The first navigation after the bridge has been idle sometimes fails with "Navigation rejected"
  // (seen twice on 2026-10-12). A navigation is a plain page load, so one retry is safe.
  try {
    await page.goto(url);
  } catch (error) {
    if (!/Navigation rejected/i.test(String(error?.message))) throw error;
    await page.wait({ time: 1 });
    await page.goto(url);
  }
  await page.wait(3);
  const where = await page.evaluate(() => ({ host: location.hostname }));
  const host = String(where?.host ?? '');
  if (/passport|plogin/.test(host)) throw new AuthRequiredError('jd.com', 'JD login required in this browser');
  if (host !== 'club.jd.com') {
    throw new CommandExecutionError(
      `${label}: JD redirected to ${host || 'an unknown page'}`,
      'JD may be rate limiting or asking for verification; open the page in Chrome to check',
    );
  }
}

// The review form of one order, or null when the page is not that order's form.
// needsTags marks products whose form asks for tag choices these commands cannot supply.
// fresh: the OpenCLI extension skips navigation when the tab is already at the same URL, so a re-read
// after submitting needs a distinct URL to get the server's current state.
export async function probeReviewForm(page, orderId, label, { fresh = false } = {}) {
  await openClubPage(page, `${BASE}/orderVoucher.action?ruleid=${orderId}${fresh ? `&_=${Date.now()}` : ''}`, label);
  // The page script adds tag sections after a JSONP reply; give it a fixed moment beyond "DOM stable".
  await page.wait({ time: 1.5 });
  const form = await page.evaluate(() => ({
    oid: document.querySelector('.detail-hd')?.getAttribute('oid') ?? '',
    anonymousChecked: !!document.querySelector('#check1')?.checked,
    goods: [...document.querySelectorAll('.f-item.f-goods')].map((el) => ({
      skuId: (el.className.match(/\bproduct-(\d+)\b/) || [])[1] ?? '',
      title: (el.querySelector('.p-name a')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      needsTags: !!el.querySelector('.J-mjyx, .J-vTags'),
    })),
  }));
  if (form?.oid !== orderId || !Array.isArray(form.goods)) return null;
  if (form.goods.some((g) => !/^\d{4,24}$/.test(g.skuId))) return null;
  return form;
}

export async function readReviewForm(page, orderId, label) {
  const form = await probeReviewForm(page, orderId, label);
  if (!form) {
    throw new CommandExecutionError(
      `${label}: review form not recognized for order ${orderId}`,
      'The order may not be awaiting review, or JD changed the page',
    );
  }
  return form;
}
