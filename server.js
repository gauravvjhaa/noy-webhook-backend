import express from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import url from 'url';
import Razorpay from 'razorpay';


dotenv.config();

const __filename = url.fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* ============= BASIC ENV CHECK (minimal) ============= */
const need = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'RAZORPAY_WEBHOOK_SECRET',
  'SMTP_USER',
  'SMTP_APP_PASSWORD',
  'EMAIL_FROM'
];
for (const k of need) {
  if (!process.env[k]) {
    console.error(`Missing env ${k}`);
    process.exit(1);
  }
}


// RAZORPAY
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});


/* ============= SUPABASE + MAILER ============= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_APP_PASSWORD
  }
});

/* ============= LOAD HTML TEMPLATE ============= */
const TEMPLATE_PATH = path.join(__dirname, 'order_confirmation_template.html');
let TEMPLATE_CACHE = null;
function loadTemplate() {
  if (!TEMPLATE_CACHE) {
    TEMPLATE_CACHE = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  }
  return TEMPLATE_CACHE;
}

/* ============= HELPERS ============= */
function renderTemplate(tpl, map) {
  return tpl.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, k) =>
    map[k] !== undefined && map[k] !== null ? String(map[k]) : ''
  );
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function currencySymbol(code) {
  switch ((code || 'INR').toUpperCase()) {
    case 'USD': return '$';
    case 'EUR': return '€';
    default: return '₹';
  }
}

function buildItemsHTML(items, sym) {
  return items.map(it => {
    const p = it.product || {};
    const v = it.variant || {};
    const title = p.product_title || 'Product';
    const variant = v.size_or_age ? ` • ${v.size_or_age}` : '';
    const qty = it.quantity || 0;
    const total = it.total_price != null
      ? Number(it.total_price)
      : Number(it.price || 0) * qty;
    const img = p.image1
      ? `<img src="${esc(p.image1)}" alt="${esc(title)}" style="width:60px;height:60px;object-fit:cover;border-radius:6px;border:1px solid #eee;" />`
      : `<div style="width:60px;height:60px;border:1px solid #eee;border-radius:6px;background:#fafafa;font-size:11px;display:flex;align-items:center;justify-content:center;color:#888;">No Img</div>`;

    return `
      <tr>
        <td style="padding:8px;border:1px solid #e5e5e5;text-align:center;">${img}</td>
        <td style="padding:8px;border:1px solid #e5e5e5;">
          <div style="font-weight:600;font-size:14px;line-height:1.3;">${esc(title)}${esc(variant)}</div>
          <div style="font-size:12px;color:#666;margin-top:2px;">Qty: ${qty}</div>
        </td>
        <td style="padding:8px;border:1px solid #e5e5e5;text-align:right;font-size:14px;font-weight:600;">
          ${sym}${total.toFixed(2)}
        </td>
      </tr>
    `;
  }).join('');
}

/* ============= FETCH DATA ============= */
async function fetchOrderBundle(orderId) {
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select(`
      order_id,
      user_id,
      order_date,
      total_amount,
      status,
      payment_id,
      shipping_address_id,
      currency,
      base_currency,
      display_currency,
      display_total_amount,
      payment_method
    `)
    .eq('order_id', orderId)
    .single();
  if (orderErr || !order) throw new Error('order_not_found');

  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('id,name,email')
    .eq('id', order.user_id)
    .single();
  if (userErr || !user || !user.email) throw new Error('user_not_found_or_no_email');

  const { data: addr, error: addrErr } = await supabase
    .from('user_addresses')
    .select('*')
    .eq('id', order.shipping_address_id)
    .single();
  if (addrErr || !addr) throw new Error('address_not_found');

  const { data: items, error: itemsErr } = await supabase
    .from('order_items')
    .select(`
      id,
      quantity,
      price,
      total_price,
      product:products(product_title,image1,slug),
      variant:product_variants(size_or_age)
    `)
    .eq('order_id', orderId);
  if (itemsErr || !items) throw new Error('items_not_found');

  return { order, user, addr, items };
}

/* ============= EMAIL SENDER ============= */
async function sendOrderEmail({ order, user, addr, items }) {
  const cur = order.display_currency || order.currency || 'INR';
  const sym = currencySymbol(cur);

  // subtotal from items
  const subtotal = items.reduce((sum, it) => {
    const qty = it.quantity || 0;
    const line = it.total_price != null
      ? Number(it.total_price)
      : Number(it.price || 0) * qty;
    return sum + line;
  }, 0);

  // shipping (simple: assume 0 or difference)
  const grand = order.display_total_amount != null
    ? Number(order.display_total_amount)
    : Number(order.total_amount);
  let shipping = grand - subtotal;
  if (shipping < 0.0001) shipping = 0;

  const itemsHTML = buildItemsHTML(items, sym);

  const tpl = loadTemplate();
  const html = renderTemplate(tpl, {
    customer_name: user.name || 'Customer',
    order_id: order.order_id,
    order_date: new Date(order.order_date || Date.now()).toLocaleString(),
    payment_method: (order.payment_method || (order.payment_id ? 'ONLINE' : 'UNKNOWN')).toUpperCase(),
    status: order.status,
    currency_symbol: sym,
    subtotal: subtotal.toFixed(2),
    shipping_display: shipping > 0 ? sym + shipping.toFixed(2) : 'Free',
    grand_total: grand.toFixed(2),
    items_html: itemsHTML,
    address_line1: addr.address_line1,
    address_line2: addr.address_line2 || '',
    city: addr.city,
    state: addr.state,
    pincode: addr.zip_code,
    phone: addr.phone,
    order_status_url: process.env.BASE_SITE_URL
      ? `${process.env.BASE_SITE_URL}/profile`
      : '#',
    support_url: process.env.SUPPORT_URL || '#',
    instagram_url: process.env.INSTAGRAM_URL || '#',
    facebook_url: process.env.FACEBOOK_URL || '#',
    youtube_url: process.env.YOUTUBE_URL || '#',
    linkedin_url: process.env.LINKEDIN_URL || '#',
    unsubscribe_url: process.env.UNSUBSCRIBE_URL || '#',
    current_year: new Date().getFullYear()
  });

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: user.email,
    subject: `Your NEW OF YOU Order #${order.order_id} Confirmation`,
    html
  });

  console.log(`Sent order email #${order.order_id} → ${user.email}`);
}

/* ============= EXPRESS APP ============= */
const app = express();

/* Health */
app.get('/health', (_, res) => res.json({ ok: true }));

/* Raw body for webhook */
app.use('/razorpay/webhook', express.raw({ type: 'application/json' }));

/* OTHER JSON (not needed but fine) */
app.use(express.json());

/* Webhook */
app.post('/razorpay/webhook', async (req, res) => {
  const sig = req.headers['x-razorpay-signature'];
  const raw = req.body; // Buffer
  let payload;

  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).send('Bad JSON');
  }

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(raw)
    .digest('hex');

  if (expected !== sig) {
    return res.status(400).send('Invalid signature');
  }

  // 🔹 Case 1: Authorized → Capture immediately
  if (payload.event === 'payment.authorized') {
    const paymentId = payload.payload.payment.entity.id;
    const amount    = payload.payload.payment.entity.amount;

    try {
      const response = await razorpay.payments.capture(paymentId, amount, 'INR');
      console.log('Payment captured via webhook:', response);
    } catch (err) {
      console.error('Capture failed:', err);
    }
    return res.json({ status: 'captured_from_authorized' });
  }

  // 🔹 Case 2: Captured → send email
  if (payload.event === 'payment.captured') {
    const internalOrderId =
      payload?.payload?.payment?.entity?.notes?.internal_order_id;

    if (!internalOrderId) {
      return res.status(400).send('Missing internal_order_id');
    }

    const orderIdNum = Number(internalOrderId);
    if (Number.isNaN(orderIdNum)) {
      return res.status(400).send('Invalid internal_order_id');
    }

    try {
      const bundle = await fetchOrderBundle(orderIdNum);
      await sendOrderEmail(bundle);
      return res.json({ status: 'ok' });
    } catch (e) {
      console.error('Processing error:', e.message);
      return res.status(500).send('error');
    }
  }

  // 🔹 All other events
  return res.json({ status: 'ignored_event' });
});

/* Start */
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});