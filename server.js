const express = require('express');
const app = express();
const cors = require('cors');
const stripe = require('stripe')('sk_test_51RekxBAc65pROHTAQJaQgffZEGaKTy5ANkq7vOFy3LJM5k2i0IPV7myoAVt904PdLk7FxZIcPGJj76tkAi1SaOT60021lEBL12'); 
const bodyParser = require('body-parser');
const path = require('path');

app.use(cors());
app.use(express.static('public'));
app.use(bodyParser.json());

app.post('/create-checkout-session', async (req, res) => {
  const {
    name,
    email,
    phone,
    pickup,
    dropoff,
    datetime,
    vehicleType,
    totalFare
  } = req.body;

  if (!email || !totalFare || totalFare < 10) {
    return res.status(400).json({ error: 'Invalid booking data.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'aud',
          product_data: {
            name: `Chauffeur Booking – ${vehicleType.toUpperCase()}`,
            description: `Pickup: ${pickup}, Dropoff: ${dropoff}, Time: ${datetime}`
          },
          unit_amount: Math.round(totalFare * 100)
        },
        quantity: 1
      }],
      success_url: 'https://bookingform-pi.vercel.app/success.html', 
      cancel_url: 'https://bookingform-pi.vercel.app/cancel.html'    
    });

    return res.status(200).json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Stripe session creation failed.' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
