// server.js
// -----------------------------
// Express + Shopify Admin GraphQL
// يحفظ نفس مبلغ PayPal في Shopify (بدون ضرب السعر بالكمية)
// -----------------------------

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(express.json());

// ====== ENV ======
const SHOP = process.env.SHOPIFY_STORE;                  // مثال: "laicea"
const ADMIN_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;    // Admin API token
const API_VER = process.env.SHOPIFY_API_VERSION || '2024-07';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;       // مثال: https://www.laicea.com

if (!SHOP || !ADMIN_TOKEN) {
  console.error('❌ Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN env vars');
}

app.use(cors({
  origin(origin, cb) {
    // اسمح للمتجر أو للأصل المحدد، أو للطلبات بدون Origin (مثل Postman)
    if (!origin) return cb(null, true);
    try {
      const okOrigins = new Set([
        `https://${SHOP}.myshopify.com`,
        `https://www.${SHOP}.com`,
      ]);
      if (ALLOWED_ORIGIN) okOrigins.add(ALLOWED_ORIGIN);
      if ([...okOrigins].some(o => origin.startsWith(o))) return cb(null, true);
      return cb(null, false);
    } catch (e) {
      return cb(null, true);
    }
  }
}));

const GQL_ENDPOINT = `https://${SHOP}.myshopify.com/admin/api/${API_VER}/graphql.json`;

async function shopifyGraphQL(query, variables) {
  const res = await fetch(GQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Shopify GraphQL HTTP ${res.status}: ${txt}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// حوّل رقم الفاريانت إلى GID إن وصل رقم فقط
function toVariantGID(id) {
  const s = String(id);
  if (s.startsWith('gid://shopify/')) return s;
  return `gid://shopify/ProductVariant/${s}`;
}

// إجلب أسعار الفاريانتات لبناء نسب التوزيع
async function getVariantsPrices(variantIds) {
  const ids = variantIds.map(toVariantGID);
  const query = `
    query($ids:[ID!]!) {
      nodes(ids:$ids) {
        ... on ProductVariant {
          id
          price {
            amount
            currencyCode
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(query, { ids });
  const map = new Map();
  for (const node of data.nodes) {
    if (!node || !node.price) continue;
    const id = node.id;
    const amount = parseFloat(node.price.amount || '0');
    map.set(id, { price: amount, currency: node.price.currencyCode });
  }
  return map;
}

// وزّع subtotal المستهدف على البنود بحسب الأسعار الأصلية
function buildAdjustedItems(rawItems, priceMap, targetSubtotal) {
  // احسب مساهمة كل بند بسعره الأصلي
  const enriched = rawItems.map(it => {
    const gid = toVariantGID(it.variant_id);
    const p = priceMap.get(gid)?.price ?? 0;
    const baseLine = +(p * it.quantity).toFixed(2);
    return { ...it, gid, baseUnitPrice: p, baseLine };
  });

  const baseSum = enriched.reduce((s, it) => s + it.baseLine, 0);
  const count = enriched.length;

  // لو ما قدرنا نجيب أسعار، قسّم بالتساوي
  const adjusted = [];
  let running = 0;

  for (let i = 0; i < count; i++) {
    const it = enriched[i];
    const share = baseSum > 0 ? (it.baseLine / baseSum) : (1 / count);
    const newLine = (i < count - 1)
      ? +(targetSubtotal * share).toFixed(2)
      : +(targetSubtotal - running).toFixed(2);
    running += newLine;

    const unit = it.quantity > 0 ? +(newLine / it.quantity).toFixed(2) : 0;

    adjusted.push({
      variantId: it.gid,
      quantity: it.quantity,
      originalUnitPrice: unit.toFixed(2) // ← نرسلها لDraftOrder
    });
  }
  return adjusted;
}

// أنشئ DraftOrder ثم أكمِله كمدفوع
async function createPaidOrder({ adjustedItems, shippingPrice, shippingLabel, note }) {
  const input = {
    lineItems: adjustedItems.map(li => ({
      variantId: li.variantId,
      quantity: li.quantity,
      originalUnitPrice: li.originalUnitPrice
    })),
    shippingLine: shippingPrice && shippingPrice > 0 ? {
      title: shippingLabel || 'Shipping',
      price: shippingPrice.toFixed(2)
    } : null,
    note: note || undefined,
    tags: ['paypal-custom-checkout'],
  };

  const mutationCreate = `
    mutation($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id name }
        userErrors { field message }
      }
    }
  `;
  const createRes = await shopifyGraphQL(mutationCreate, { input });
  const uerr = createRes?.draftOrderCreate?.userErrors || [];
  if (uerr.length) {
    throw new Error('draftOrderCreate errors: ' + JSON.stringify(uerr));
  }
  const draftId = createRes?.draftOrderCreate?.draftOrder?.id;
  if (!draftId) throw new Error('No draft order id');

  const mutationComplete = `
    mutation($id: ID!, $paymentPending: Boolean!) {
      draftOrderComplete(id: $id, paymentPending: $paymentPending) {
        order { id name }
        userErrors { field message }
      }
    }
  `;
  const comp = await shopifyGraphQL(mutationComplete, { id: draftId, paymentPending: false });
  const cErr = comp?.draftOrderComplete?.userErrors || [];
  if (cErr.length) {
    throw new Error('draftOrderComplete errors: ' + JSON.stringify(cErr));
  }
  const order = comp?.draftOrderComplete?.order;
  return order;
}

// نفس المنطق لكلا الإندبوينتَين
async function handleOrderFromPaypalFixed(req, res) {
  try {
    const {
      // من سكربت الواجهة
      total_paid,           // المبلغ النهائي المدفوع لدى PayPal (يتضمن الشحن)
      shipping_price,       // قيمة الشحن كرقم/سترنغ
      shipping_label,       // label اختياري
      line_items = [],      // [{ variant_id, quantity }]
      paypalOrderId,        // اختياري للتوثيق
      paypalCaptureId       // اختياري للتوثيق
    } = req.body || {};

    const paid = +parseFloat(total_paid || 0).toFixed(2);
    const ship = +parseFloat(shipping_price || 0).toFixed(2);
    if (!(paid >= 0) || !(ship >= 0)) {
      return res.status(400).json({ ok: false, error: 'Invalid totals' });
    }
    if (!Array.isArray(line_items) || !line_items.length) {
      return res.status(400).json({ ok: false, error: 'No line items' });
    }

    const targetSubtotal = +(paid - ship).toFixed(2);
    if (targetSubtotal < 0) {
      return res.status(400).json({ ok: false, error: 'Negative subtotal' });
    }

    // جهّز IDs لجلب الأسعار
    const ids = line_items.map(x => x.variant_id);
    const priceMap = await getVariantsPrices(ids);

    // وزّع المبلغ على البنود
    const adjustedItems = buildAdjustedItems(
      line_items.map(x => ({ variant_id: x.variant_id, quantity: x.quantity })),
      priceMap,
      targetSubtotal
    );

    // اكتب ملاحظة فيها بيانات PayPal
    const note = [
      paypalOrderId ? `PayPal order ${paypalOrderId}` : null,
      paypalCaptureId ? `capture ${paypalCaptureId}` : null
    ].filter(Boolean).join(' | ') || 'PayPal custom checkout';

    // أنشئ الطلب مدفوع
    const order = await createPaidOrder({
      adjustedItems,
      shippingPrice: ship,
      shippingLabel: shipping_label || 'Shipping',
      note
    });

    return res.json({ ok: true, order });
  } catch (err) {
    console.error('❌ order-from-paypal-fixed error:', err);
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
}

// الإندبوينت الرئيسي الجديد (كما في سكربت الواجهة)
app.post('/api/shopify/order-from-paypal-fixed', handleOrderFromPaypalFixed);

// للتوافق مع القديم—نحوّل لنفس المنطق (لو الواجهة القديمة لسه بتضرب)
app.post('/api/shopify/order-from-paypal', handleOrderFromPaypalFixed);

// صحة السيرفر
app.get('/', (req, res) => res.send('OK'));

// شغّل
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✅ Server up on :' + PORT);
});
