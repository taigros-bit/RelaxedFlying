export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let email;
  try {
    email = req.body?.email;
  } catch(e) {}
  
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const response = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.BREVO_API_KEY
      },
      body: JSON.stringify({
        email: email,
        listIds: [2],
        updateEnabled: true
      })
    });

    const text = await response.text();
    console.log('Brevo status:', response.status);
    console.log('Brevo response:', text);

    return res.status(200).json({ success: true });

  } catch (e) {
    console.log('Error:', e.message);
    return res.status(200).json({ success: true });
  }
}
