# JD.com

**Mode**: 🔐 Browser · **Domain**: `item.jd.com`, `club.jd.com`

## Commands

| Command | Description |
|---------|-------------|
| `opencli jd item <sku>` | Fetch product details (price, shop, specs, AVIF images) |
| `opencli jd pending-reviews` | List orders awaiting review, one row per product (20 orders per page) |
| `opencli jd review-form <order>` | List the products (with SKU) awaiting review in one order |
| `opencli jd submit-review <order>` | Submit one product review; a dry run unless `--confirm` is passed |

## Usage Examples

```bash
# Get product details by SKU
opencli jd item 100291143898

# Limit returned AVIF images
opencli jd item 100291143898 --images 5

# JSON output
opencli jd item 100291143898 -f json

# Orders awaiting review (page 2: --page 2)
opencli jd pending-reviews -f json

# Products and SKUs awaiting review in one order
opencli jd review-form 123456789012

# Dry run: reads the form and prints what would be sent, sends nothing
opencli jd submit-review 123456789012 --score 5 --content "质量不错"

# Submit
opencli jd submit-review 123456789012 --score 5 --content "质量不错" --confirm

# An order with several products needs --sku
opencli jd submit-review 123456789012 --sku 100012345678 --score 5 --content "质量不错" --confirm

# With pictures (up to 9; jpg/png/gif/bmp, 4 MB each)
opencli jd submit-review 123456789012 --score 5 --content "质量不错" --images a.jpg,b.png --confirm
```

## Reviews

- `submit-review` publishes a review on JD under the logged-in account. Without `--confirm` it only reads the review form and returns a `dry-run` row.
- Reviews are anonymous by default, the same as the JD form. Pass `--public` to show the nickname.
- The command refuses, before sending anything, when the order has several products and `--sku` is missing, when the product is not awaiting review, or when the form asks for tag choices (those products must be reviewed in the browser).
- After JD accepts the review the command re-reads the form. `verified` is `yes` when the product is no longer listed, `no` when it still is, and `unknown` when the form could not be read.
- If JD's reply is not recognized, check the order in the browser before trying again; the review may already be saved.
- Status on 2026-10-12: `pending-reviews`, `review-form` and text-only `submit-review` were run against JD. `--images` follows JD's page script and passed offline checks against JD's uploader build; it has not been run against JD.

## Prerequisites

- Chrome running and **logged into** jd.com
- [Browser Bridge extension](/guide/browser-bridge) installed
