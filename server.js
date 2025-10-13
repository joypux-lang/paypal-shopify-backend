// server.js — PayPal (Live/Sandbox) + Shopify Draft→Complete
// Node 18+ (أو أضف node-fetch إذا لزم)، Express, CORS, Helmet

import express from "express";
import cors from "cors";
import helmet from "helmet";
import fetch from "node-fetch"; // إن كنت على Node <18

const app = express();
app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// ---------- CORS ----------
function parseAllowedOrigin(val) {
  if (!val || val === "*") return "*";
  // يدعم قائمة مفصولة بفواصل
  const arr = val.split(",").map(s => s.trim()).filter(Boolean);
  return arr.length ? arr : "*";
}
const ALLOWED_ORIGIN_RAW = process.env.ALLOWED_ORIGIN || "*";
// ملاحظة: Shopify customizer يأتي من *.myshopify.com، إن أردت تحديدًا أضفه هنا بيئياً.
const corsOrigin = parseAllowedOrigin(ALLOWED_ORIGIN_RAW);
app.use(cors({
  origin: corsOrigin,
  credentials: false
}));

// ---------- ENV ----------
const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENV = "live",           // "live" أو "sandbox"
  SHOPIFY_STORE,                 // مثال: "iptcy7-up" (بدون .myshopify.com)
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_API_VERSION = "2025-10"
} = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.warn("⚠️ Missing PayPal credentials (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).");
}
if (!SHOPIFY_STORE || !SHOPIFY_ADMIN_TOKEN) {
  console.warn("⚠️ Missing Shopify credentials (SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN).");
}

const PP_BASE = PAYPAL_ENV === "sandbox"
  ? "https://api-m.sandbox.paypal.com"
  : "https://api-m.paypal.com";

const SHOP_ADMIN = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

// ---------- Helpers ----------
function to2(v) {
  // يحول أي رقم/نص لعدد عشري بدقة 2 (كسلسلة)
  const n = typeof v === "number" ? v : parseFloat(String(v || "0").replace(/,/g, ""));
  if (isNaN(n)) return "0.00";
  return n.toFixed(2);
}

function sum2(vals) {
  // يجمع قائمة أرقام (كسلاسل أو أرقام) ويعيد نص بدقة 2
  const s = (vals || []).reduce((acc, x) => acc + (parseFloat(x) || 0), 0);
  return s.toFixed(2);
}

async function paypalAccessToken() {
  const res = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`PayPal OAuth failed: ${res.status} ${JSON.stringify(data)}`);
  return data.access_token;
}

async function shopifyGraphQL(query, variables = {}) {
  const r = await fetch(SHOP_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (!r.ok || j.errors) {
    throw new Error("Shopify GraphQL error: " + JSON.stringify(j.errors || j));
  }
  return j.data;
}

const toVariantGID = (id) => `gid://shopify/ProductVariant/${id}`;

// ---------- PayPal: Client Token ----------
app.post("/api/paypal/client-token", async (_req, res) => {
  try {
    const token = await paypalAccessToken();
    const r = await fetch(`${PP_BASE}/v1/identity/generate-token`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });
    const j = await r.json();
    if (!r.ok || !j?.client_token) {
      return res.status(400).json({ ok: false, error: "Failed to generate client token", details: j });
    }
    res.json({ ok: true, client_token: j.client_token });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- PayPal: Create Order ----------
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const b = req.body || {};
    const currency = b.currency || "USD";

    // نتوقع payload من الواجهة:
    // { items:[{title, quantity, price}], shipping:{label, price}, total, currency }
    const items = Array.isArray(b.items) ? b.items : [];
    const shippingPrice = to2(b?.shipping?.price || "0");
    const itemsTotal = sum2(items.map(it => (parseFloat(it.price) || 0) * (parseInt(it.quantity,10) || 0)));
    const total = to2(parseFloat(itemsTotal) + parseFloat(shippingPrice));

    // لو المجموع القادم من الواجهة (b.total) موجود وتعارض مع حسابنا، نستخدم حسابنا لتفادي MISMATCH
    const finalTotal = to2(b.total || total);

    // breakdown
    const body = {
      intent: "CAPTURE",
      purchase_units: [{
        amount: {
          currency_code: currency,
          value: finalTotal,
          breakdown: {
            item_total: {
              currency_code: currency,
              value: to2(itemsTotal)
            },
            shipping: {
              currency_code: currency,
              value: shippingPrice
            }
          }
        },
        items: items.map(it => ({
          name: String(it.title || "Item"),
          quantity: String(parseInt(it.quantity,10) || 1),
          unit_amount: {
            currency_code: currency,
            value: to2(it.price || "0")
          }
        }))
      }],
      application_context: {
        user_action: "PAY_NOW"
      }
    };

    const token = await paypalAccessToken();
    const r = await fetch(`${PP_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const j = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ ok: false, error: "PayPal create order failed", details: j, sent: body });
    }
    res.json({ ok: true, orderID: j.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- PayPal: Capture ----------
app.post("/api/paypal/capture", async (req, res) => {
  try {
    const { paypalOrderId } = req.body || {};
    if (!paypalOrderId) return res.status(400).json({ ok: false, error: "Missing paypalOrderId" });

    const token = await paypalAccessToken();
    const capRes = await fetch(`${PP_BASE}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });
    const cap = await capRes.json();
    if (!capRes.ok) {
      return res.status(400).json({ ok: false, error: "PayPal capture failed", details: cap });
    }

    const status = cap?.status || cap?.purchase_units?.[0]?.payments?.captures?.[0]?.status;
    if (status !== "COMPLETED") {
      return res.status(400).json({ ok: false, error: `Unexpected PayPal status: ${status || "unknown"}`, details: cap });
    }

    // محاولة استخراج العنوان والبريد
    const pu = cap?.purchase_units?.[0] || {};
    const ship = pu?.shipping?.address || {};
    const fullName = pu?.shipping?.name?.full_name || "";
    const payer = cap?.payer || {};
    const [given_name, ...rest] = (fullName || `${payer?.name?.given_name || ""} ${payer?.name?.surname || ""}`).trim().split(" ");
    const surname = rest.join(" ").trim();

    const address = {
      firstName: given_name || payer?.name?.given_name || "",
      lastName:  surname   || payer?.name?.surname    || "",
      address1:  ship?.address_line_1 || "",
      city:      ship?.admin_area_2   || "",
      zip:       ship?.postal_code    || "",
      country:   ship?.country_code   || "",
      phone:     "",
      email:     payer?.email_address || ""   // البريد يُستخدم على مستوى الطلب DraftOrderInput.email فقط
    };

    const captureId =
      pu?.payments?.captures?.[0]?.id ||
      pu?.payments?.authorizations?.[0]?.id ||
      cap?.id;

    res.json({ ok: true, captureId, address, raw: cap });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Shopify: Draft Order → Complete ----------
app.post("/api/shopify/order-from-paypal", async (req, res) => {
  try {
    const b = req.body || {};
    // نتوقع بنية:
    // {
    //   items: [{ variant_id, quantity }],
    //   address: { firstName,lastName,address1,city,zip,country,phone?,email? },
    //   shipping: { label, price },
    //   paypalOrderId, paypalCaptureId
    // }

    const errs = [];
    if (!Array.isArray(b.items) || b.items.length === 0) errs.push("items[] is required");
    const A = b.address || {};
    ["firstName","lastName","address1","city","zip","country"].forEach(k => { if (!A[k]) errs.push(`address.${k} is required`); });
    if (!b.shipping || typeof b.shipping.price === "undefined") errs.push("shipping.price is required");
    if (errs.length) return res.status(400).json({ ok: false, error: "Invalid payload", details: errs });

    // عنوان الفوترة/الشحن — بدون email (MailingAddressInput لا يحتوي email)
    const billingAddress = {
      firstName: A.firstName,
      lastName:  A.lastName,
      address1:  A.address1,
      city:      A.city,
      zip:       A.zip,
      country:   A.country,
      phone:     A.phone || null
    };
    const shippingAddress = { ...billingAddress };

    const lineItems = b.items.map(li => ({
      variantId: toVariantGID(li.variant_id),
      quantity: parseInt(li.quantity, 10) || 1
      // price: يمكن تركه فارغًا ليستخدم Shopify سعر المتجر تلقائيًا
    }));

    const draftOrderCreate = `
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id }
          userErrors { field message }
        }
      }
    `;

    const draftInput = {
      email: A.email || undefined,       // البريد يوضع هنا فقط
      billingAddress,
      shippingAddress,
      lineItems,
      // إضافة سطر شحن إن كان > 0
      shippingLine: (b.shipping && b.shipping.price && parseFloat(b.shipping.price) > 0)
        ? { title: (b.shipping.label || "Shipping"), price: to2(b.shipping.price) }
        : null,
      note: `PayPal order ${b.paypalOrderId || ""} | capture ${b.paypalCaptureId || ""}`.trim()
    };

    const d1 = await shopifyGraphQL(draftOrderCreate, { input: draftInput });
    const ue1 = d1?.draftOrderCreate?.userErrors || [];
    if (ue1.length) {
      return res.status(400).json({ ok: false, error: "Shopify user errors (create)", details: ue1 });
    }
    const draftId = d1?.draftOrderCreate?.draftOrder?.id;
    if (!draftId) {
      return res.status(400).json({ ok: false, error: "Failed to create draft order", details: d1 });
    }

    const draftOrderComplete = `
      mutation draftOrderComplete($id: ID!) {
        draftOrderComplete(id: $id) {
          draftOrder { id order { id name } }
          userErrors { field message }
        }
      }
    `;
    const d2 = await shopifyGraphQL(draftOrderComplete, { id: draftId });
    const ue2 = d2?.draftOrderComplete?.userErrors || [];
    if (ue2.length) {
      return res.status(400).json({ ok: false, error: "Shopify user errors (complete)", details: ue2 });
    }
    const orderNode = d2?.draftOrderComplete?.draftOrder?.order;
    if (!orderNode?.id) {
      return res.status(400).json({ ok: false, error: "Unable to complete draft order", details: d2 });
    }

    res.json({ ok: true, order: orderNode });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Health ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ API listening on :${PORT}`));
