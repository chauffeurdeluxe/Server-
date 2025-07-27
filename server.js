const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const stripe = require("stripe")("sk_test_51RekxBAc65pROHTAjKrHFHa6E4dpWbWr7FL9Y6bOduU7NGrcMfL7YbhmAyMGwzWUxGUtMN0frO6BEI78K6TLalFf00EoHQL0oV");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.post("/create-checkout-session", async (req, res) => {
  const { amount } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "aud",
          product_data: { name: "Chauffeur Booking" },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      mode: "payment",
      success_url: "https://bookingform-pi.vercel.app/success",
      cancel_url: "https://bookingform-pi.vercel.app/cancel",
    });

    res.json({ id: session.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Stripe session error" });
  }
});

// OPTIONAL: Webhook for post-payment email
app.post("/webhook", express.raw({ type: "application/json" }), async (request, response) => {
  const sig = request.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      request.body,
      sig,
      "whsec_xxxxxxxx" // Replace with your real webhook secret
    );
  } catch (err) {
    console.log(`⚠️ Webhook error: ${err.message}`);
    return response.sendStatus(400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    // Send confirmation email
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: "chauffeurdeluxe@yahoo.com",
        pass: "YOUR_APP_PASSWORD" // App password only, not your main Yahoo password
      }
    });

    const mailOptions = {
      from: "chauffeurdeluxe@yahoo.com",
      to: "chauffeurdeluxe@yahoo.com",
      subject: "New Chauffeur Booking Confirmed",
      text: `A new payment was successfully made. Amount: $${(session.amount_total / 100).toFixed(2)}`
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log("✅ Email sent after payment.");
    } catch (emailErr) {
      console.error("❌ Failed to send email:", emailErr);
    }
  }

  response.json({ received: true });
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
