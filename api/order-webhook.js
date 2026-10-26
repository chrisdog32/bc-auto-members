// Retired duplicate purchase mutations. Native Mailchimp for BigCommerce handles customer and order sync.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });
  return res.status(200).json({ message: "Acknowledged. Customer and order sync is handled by Mailchimp for BigCommerce." });
}
