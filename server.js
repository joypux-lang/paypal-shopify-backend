<script>
document.addEventListener('DOMContentLoaded', function () {
  var API_BASE = "{{ section.settings.api_base_url | escape }}".replace(/\/+$/,'');
  var currency = "{{ cart.currency.iso_code }}";

  // ✅ مجموع السلة من Shopify كسِنت → إلى عملة (أدق لكل اللغات/التنسيقات)
  var cartSubtotal = ({{ cart.total_price | default: 0 }}) / 100.0;

  // تنسيق المبالغ حسب العملة
  function fmt(v) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(v);
    } catch (e) {
      return (v || 0).toFixed(2) + ' ' + currency;
    }
  }

  function shipValue(){
    var r = document.querySelector('input[name="co-ship"]:checked');
    return parseFloat(r && r.value || 0);
  }
  function shipLabel(){
    var r = document.querySelector('input[name="co-ship"]:checked');
    return r ? (r.getAttribute('data-label') || 'Shipping') : 'Shipping';
  }
  function total(){ return (cartSubtotal + shipValue()); }
  function renderTotals(){
    var sEl = document.getElementById('co-ship-val');
    var tEl = document.getElementById('co-total');
    if (sEl) sEl.textContent = shipValue() ? fmt(shipValue()) : '—';
    if (tEl) tEl.textContent = fmt(total());
  }
  document.querySelectorAll('input[name="co-ship"]').forEach(function(el){ el.addEventListener('change', renderTotals); });
  renderTotals();

  function showErr(msg){
    var el = document.getElementById('co-alert');
    if (el) {
      el.textContent = msg || 'Something went wrong.';
      el.hidden = false;
    }
  }
  function clearErr(){ var el = document.getElementById('co-alert'); if (el) el.hidden = true; }

  if ({{ cart.item_count | default: 0 }} <= 0) {
    showErr('Your cart is empty.');
    return;
  }

  // 🔥 توزيع أي فرق خصم على البنود وإرسال price مخصص لكل بند
  function buildAdjustedLineItems(){
    // line_price من Shopify بالسنت → عملة
    var items = [
      {% for item in cart.items %}
      {
        variant_id: {{ item.variant_id }},
        quantity: {{ item.quantity }},
        line_subtotal: ({{ item.line_price }}) / 100.0
      }{% unless forloop.last %},{% endunless %}
      {% endfor %}
    ];

    var currentSubtotal = items.reduce(function(s, it){ return s + it.line_subtotal; }, 0);
    var targetSubtotal  = total() - shipValue(); // المجموع المرغوب بدون الشحن

    var diff = +(currentSubtotal - targetSubtotal).toFixed(2);
    if (Math.abs(diff) < 0.01) {
      // لا يوجد فرق فعلي → لا نرسل price (Shopify يستخدم سعر المتغير)
      return items.map(function(it){
        return { variant_id: it.variant_id, quantity: it.quantity };
      });
    }

    // وزّع الفرق بنسبة مساهمة كل بند؛ آخر بند يأخذ الباقي لضبط التقريب
    var adjusted = [];
    var running = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var share = currentSubtotal > 0 ? (it.line_subtotal / currentSubtotal) : 1/items.length;
      var newLine = (i < items.length - 1)
        ? +(targetSubtotal * share).toFixed(2)
        : +(targetSubtotal - running).toFixed(2);
      running += newLine;

      var unit = +(newLine / it.quantity).toFixed(2);
      adjusted.push({
        variant_id: it.variant_id,
        quantity: it.quantity,
        price: unit.toFixed(2) // 👈 سيروح للسيرفر ثم Shopify كـ DraftOrder lineItems.price
      });
    }
    return adjusted;
  }

  function mountPayPal(){
    clearErr();
    if (!window.paypal || !paypal.Buttons) {
      showErr('Unable to initialize payment. Please refresh the page.');
      return;
    }
    var container = document.getElementById('paypal-button-container');
    if (container) container.innerHTML = '';

    var buttons = paypal.Buttons({
      style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'paypal', tagline:false },
      createOrder: function(data, actions) {
        var value = total().toFixed(2);
        if (!value || isNaN(value)) { console.error('CreateOrder invalid total', value); throw new Error('CreateOrder failed'); }
        return actions.order.create({
          intent: 'CAPTURE',
          purchase_units: [{ amount: { value: value } }],
          application_context: { user_action: 'PAY_NOW' }
        });
      },
      onApprove: function(data, actions) {
        return actions.order.capture().then(function(details){
          var cap = (details && details.purchase_units && details.purchase_units[0] &&
                     details.purchase_units[0].payments && details.purchase_units[0].payments.captures &&
                     details.purchase_units[0].payments.captures[0]) || null;

          var payload = {
            paypalOrderId: data.orderID,
            paypalCaptureId: cap ? cap.id : null,
            address: (function(){
              var pu = (details && details.purchase_units && details.purchase_units[0]) || {};
              var ship = pu.shipping || {}; var addr = ship.address || {};
              var full = (ship.name && ship.name.full_name) || '';
              var parts = full.trim().split(' '); var first = parts.shift() || ''; var last = parts.join(' ') || '';
              return {
                firstName: first, lastName: last,
                address1: addr.address_line_1 || '',
                city: addr.admin_area_2 || '',
                zip: addr.postal_code || '',
                country: addr.country_code || '',
                email: (details && details.payer && details.payer.email_address) || '',
                phone: ''
              };
            })(),
            shipping_label: shipLabel(),
            shipping_price: shipValue().toFixed(2),

            // ✅ البنود بعد التعديل
            line_items: buildAdjustedLineItems()
          };

          return fetch(API_BASE + '/api/shopify/order-from-paypal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
          .then(function(r){ if (!r.ok) throw new Error('Shopify order failed'); return r.json(); })
          .then(function(out){
            if (!out || !out.ok) throw new Error('Shopify order failed');
            // نظّف السلة ثم حوّل لصفحة الشكر
            return fetch('/cart/clear.js', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
              .catch(function(){})
              .finally(function(){ window.location.href = "{{ section.settings.thank_you_url | default: '/pages/thank-you' }}"; });
          })
          .catch(function(err){ console.error('Shopify order error', err); showErr('Payment completed but order creation failed. Please contact support.'); });
        }).catch(function(err){ console.error('Capture error', err); showErr('Payment could not be completed. Please try again.'); });
      },
      onError: function(err){ console.error('PayPal onError', err); showErr('Payment could not be completed. Please try again.'); }
    });

    buttons.render('#paypal-button-container');
  }

  mountPayPal();
  document.querySelectorAll('input[name="co-ship"]').forEach(function(el){
    el.addEventListener('change', function(){ renderTotals(); mountPayPal(); });
  });
});
</script>
