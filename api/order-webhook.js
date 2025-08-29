// Vercel Serverless Function: /api/order-webhook
// Moves a logged-in buyer into Members Only customer group after order is paid/completed.

const BC_STORE_HASH = process.env.BC_STORE_HASH;              // e.g., "713e0"
const BC_ACCESS_TOKEN = process.env.BC_ACCESS_TOKEN;          // from your API account
const MEMBERS_ONLY_GROUP_ID = parseInt(process.env.MEMBERS_ONLY_GROUP_ID || "6", 10);

const BC_API_BASE = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}`;

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ message: "Method not allowed" });
    }

    const body = req.body || {};
    const orderId = body?.data?.id;
    if (!orderId) {
      return res.status(200).json({ message: "No order id in payload; ignoring" });
    }

    // 1) Fetch the order (v2 Orders)
    const orderResp = await fetch(`${BC_API_BASE}/v2/orders/${orderId}`, {
      headers: {
        "X-Auth-Token": BC_ACCESS_TOKEN,
        "Accept": "application/json",
        "Content-Type": "application/json"
      }
    });
    if (!orderResp.ok) {
      const t = await orderResp.text();
      throw new Error(`Order fetch failed: ${orderResp.status} ${t}`);
    }
    const order = await orderResp.json();

    // Only proceed if the order is effectively paid.
    const okStatuses = new Set(["Completed", "Shipped", "Awaiting Fulfillment", "Awaiting Shipment"]);
    if (!okStatuses.has(order.status)) {
      return res.status(200).json({ message: `Order ${orderId} status ${order.status} not eligible yet` });
    }

    // Skip guests (no account to move)
    const customerId = order.customer_id;
    if (!customerId) {
      return res.status(200).json({ message: `Order ${orderId} is guest checkout; skipping` });
    }

    // 2) Update the customer to Members Only via v3 Customers API
    const updateResp = await fetch(`${BC_API_BASE}/v3/customers`, {
      method: "PUT",
      headers: {
        "X-Auth-Token": BC_ACCESS_TOKEN,
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        customers: [
          {
            id: customerId,
            customer_group_id: MEMBERS_ONLY_GROUP_ID
          }
        ]
      })
    });

    if (!updateResp.ok) {
      const t = await updateResp.text();
      throw new Error(`Customer update failed: ${updateResp.status} ${t}`);
    }

    return res.status(200).json({
      message: `Customer ${customerId} moved to group ${MEMBERS_ONLY_GROUP_ID} for order ${orderId}`
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
