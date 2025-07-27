const express = require('express');
const app = express();
const stripe = require('stripe')('sk_test_51RekxBAc65pROHTAQf5xtdCspmPY0r6b2hZbkDm7KP2eKJtMT7qNgVZ0QviGiZ0PCNRprZOrc5OzA50OpqxneTSX300eBGITq6u');
const cors = require('cors');

app.use(cors());
app.use(express.json());
app.get('/', (req, res) => {
  res.send('Server is running.');
});
app.post('/create-checkout-session', async (req, res) => {
  const { amount } = req.body;
console.log('Amount received from frontend:', amount);


  try {
    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: 'aud',
            product_data: {
              name: 'Chauffeur Booking Fare',
            },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      automatic_payment_methods: {
        enabled: true,
      },
      success_url: 'https://bookingform-pi.vercel.app/success.html',
      cancel_url: 'https://bookingform-pi.vercel.app/cancel.html',
    });

    res.json({ id: session.id });
  } catch (error) {
    console.error('Stripe error:', error.message);
    res.status(500).json({ error: 'Payment session creation failed' });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
