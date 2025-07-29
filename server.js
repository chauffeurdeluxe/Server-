const express = require('express');
const app = express();
const cors = require('cors');
const stripe = require('stripe')('sk_test_51RekxBAc65pROHTAQJaQgffZEGaKTy5ANkq7vOFy3LJM5k2i0IPV7myoAVt904PdLk7FxZIcPGJj76tkAi1SaOT60021lEBL12'); 
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const path = require('path');
const { google } = require('googleapis');

app.use(cors());
app.use(express.static('public'));

// To receive raw body for Stripe webhook signature verification
app.use(
  '/webhook',
  express.raw({ type: 'application/json' })
);

// For other routes parse JSON normally
app.use(bodyParser.json());

// Your Gmail OAuth2 setup (fill with your credentials)
const CLIENT_ID = '816376260321-oe4d12lnjofm3f4oe33pg4rpdjgsvr5v.apps.googleusercontent.com
';
const CLIENT_SECRET = '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';
const REDIRECT_URI = 'https://developers.google.com/oauthplayground';
const REFRESH_TOKEN = '  "refresh_token": "1//04fxT7EfUUDELCgYIARAAGAQSNwF-L9IrjEP267HotIwpq5jWY4ttFabp7qK4Gm64cCxUH5PTMeOg6yo-vUkXgAvJG1D7jCMYn1I"
}
';

const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

async function sendEmail(booking) {
  try {
    const accessToken = await oAuth2Client.getAccessToken();

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: 'superiorfutbol@gmail.com',
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: REFRESH_TOKEN,
        accessToken: accessToken.token,
      },
    });

    const mailOptions = {
      from: 'Chauffeur de Luxe <superiorfutbol@gmail.com>',
      to: 'chauffeurdeluxe@yahoo.com', // You get notified here
      subject: `New Booking from ${booking.name}`,
      html: `
        <h2>New Chauffeur Booking</h2>
        <p><strong>Name:</strong> ${booking.name}</p>
        <p><strong>Email:</strong> ${booking.email}</p>
        <p><strong>Phone:</strong> ${booking.phone}</p>
        <p><strong>Pickup:</strong> ${booking.pickup}</p>
        <p><strong>Dropoff:</strong> ${booking.dropoff}</p>
        <p><strong>Pickup Time:</strong> ${booking.datetime}</p>
        <p><strong>Vehicle Type:</strong> ${booking.vehicleType}</p>
        <p><strong>Total Fare:</strong> $${booking.totalFare}</p>
        <p><strong>Notes:</strong> ${booking.notes || 'None'}</p>
      `,
    };

    const result = await transporter.sendMail(mailOptions);
    return result;
  } catch (error) {
    console.error('Email sending error:', error);
  }
}

app.post('/create-checkout-session', async (req, res) => {
  const {
    name,
    email,
    phone,
    pickup,
    dropoff,
    datetime,
    vehicleType,
    totalFare,
    notes,
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

    // Store booking info in session metadata for webhook (optional)
    // Alternatively, you can pass info in metadata if you want

    res.status(200).json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Stripe session creation failed.' });
  }
});

// Your webhook secret from Stripe dashboard
const endpointSecret = 'whsec_6mSUcXvKfMuBgqS6YMBlpVBXb2pu4kIn';

app.post('/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Grab booking details from your DB or from metadata if you added them
    // Here you might need to fetch or store booking info elsewhere
    // For demonstration, just sending minimal info

    const booking = {
      name: session.customer_details?.name || 'N/A',
      email: session.customer_details?.email || 'N/A',
      phone: 'N/A', // You may store phone in metadata or DB
      pickup: 'N/A',
      dropoff: 'N/A',
      datetime: 'N/A',
      vehicleType: 'N/A',
      totalFare: session.amount_total / 100,
      notes: '',
    };

    // Send confirmation email
    sendEmail(booking).catch(console.error);
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

