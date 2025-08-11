require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const cron = require('node-cron');

const app = express();

// ===== Multer storage for uploaded files =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

app.use(cors());
app.use(express.static('public'));

// ===== Stripe Webhook requires raw body =====
app.use('/webhook', express.raw({ type: 'application/json' }));

// ===== Booking form uses JSON =====
app.use('/create-checkout-session', bodyParser.json());

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// ==== BOOKING EMAIL FUNCTION ====
async function sendEmail(booking) {
  try {
    const mailOptions = {
      from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO,
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
        <p><strong>Distance:</strong> ${booking.distanceKm} km</p>
        <p><strong>Estimated Time:</strong> ${booking.durationMin} min</p>
        <p><strong>Notes:</strong> ${booking.notes || 'None'}</p>
      `
    };
    await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error('Email sending error:', error);
  }
}

// ==== BOOKING ROUTES ====
app.post('/create-checkout-session', async (req, res) => {
  const { name, email, phone, pickup, dropoff, datetime, vehicleType, totalFare, distanceKm, durationMin, notes } = req.body;
  if (!email || !totalFare || totalFare < 10) return res.status(400).json({ error: 'Invalid booking data.' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'aud',
          product_data: { name: `Chauffeur Booking – ${vehicleType.toUpperCase()}`, description: `Pickup: ${pickup}, Dropoff: ${dropoff}, Time: ${datetime}` },
          unit_amount: Math.round(totalFare * 100)
        },
        quantity: 1
      }],
      metadata: { name, email, phone, pickup, dropoff, datetime, vehicleType, totalFare: totalFare.toString(), notes: notes || '', distanceKm: distanceKm ? distanceKm.toString() : 'N/A', durationMin: durationMin ? durationMin.toString() : 'N/A' },
      success_url: 'https://bookingform-pi.vercel.app/success.html',
      cancel_url: 'https://bookingform-pi.vercel.app/cancel.html'
    });
    res.status(200).json({ id: session.id, url: session.url });
  } catch (err) {
    res.status(500).json({ error: 'Stripe session creation failed.' });
  }
});

app.post('/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    sendEmail({
      name: s.metadata.name, email: s.metadata.email, phone: s.metadata.phone, pickup: s.metadata.pickup, dropoff: s.metadata.dropoff, datetime: s.metadata.datetime, vehicleType: s.metadata.vehicleType, totalFare: s.metadata.totalFare, distanceKm: s.metadata.distanceKm, durationMin: s.metadata.durationMin, notes: s.metadata.notes
    });
  }
  res.json({ received: true });
});

// ==== PARTNER/DRIVER FORM ====
// Note: NO bodyParser.json() here, multer handles it
app.post('/partner-form', upload.fields([
  { name: 'insuranceFile', maxCount: 1 },
  { name: 'regoFile', maxCount: 1 },
  { name: 'abnFile', maxCount: 1 }
]), async (req, res) => {
  const data = req.body;
  const files = req.files;

  // Save driver data to JSON
  let drivers = [];
  const dataPath = path.join(__dirname, 'drivers.json');
  if (fs.existsSync(dataPath)) drivers = JSON.parse(fs.readFileSync(dataPath));
  const driverRecord = { ...data, files, submittedAt: new Date() };
  drivers.push(driverRecord);
  fs.writeFileSync(dataPath, JSON.stringify(drivers, null, 2));

  // Send email with attachments
  const attachments = [];
  for (let field in files) {
    attachments.push({ filename: files[field][0].originalname, path: files[field][0].path });
  }
  await transporter.sendMail({
    from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
    to: process.env.EMAIL_TO,
    subject: `New Driver Partner Submission - ${data.fullName}`,
    html: `
      <h2>Driver Partner Application</h2>
      <p><strong>Company:</strong> ${data.companyName}</p>
      <p><strong>Name:</strong> ${data.fullName}</p>
      <p><strong>Email:</strong> ${data.email}</p>
      <p><strong>Phone:</strong> ${data.phone}</p>
      <p><strong>Car:</strong> ${data.carMake} ${data.carModel} (${data.carYear})</p>
      <p><strong>Registration Expiry:</strong> ${data.regoExpiry}</p>
      <p><strong>Insurance Expiry:</strong> ${data.insuranceExpiry}</p>
    `,
    attachments
  });

  res.status(200).json({ message: 'Form submitted successfully' });
});

// ==== RENEWAL REMINDER (runs daily at 9am) ====
cron.schedule('0 9 * * *', () => {
  const dataPath = path.join(__dirname, 'drivers.json');
  if (!fs.existsSync(dataPath)) return;

  const drivers = JSON.parse(fs.readFileSync(dataPath));
  const today = new Date();

  drivers.forEach(driver => {
    const regoDate = new Date(driver.regoExpiry);
    const insuranceDate = new Date(driver.insuranceExpiry);

    [{ type: 'Registration', date: regoDate }, { type: 'Insurance', date: insuranceDate }]
      .forEach(item => {
        const diffDays = Math.ceil((item.date - today) / (1000 * 60 * 60 * 24));
        if (diffDays === 30) {
          transporter.sendMail({
            from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
            to: process.env.EMAIL_TO,
            subject: `${item.type} Renewal Reminder - ${driver.fullName}`,
            text: `${driver.fullName}'s ${item.type} expires in 30 days on ${item.date.toDateString()}.`
          });
        }
      });
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
