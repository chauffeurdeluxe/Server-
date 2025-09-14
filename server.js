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
const PDFDocument = require('pdfkit');
const streamBuffers = require('stream-buffers');

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(bodyParser.json());

/* ------------------- MULTER SETUP ------------------- */
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

/* ------------------- NODEMAILER ------------------- */
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

/* ------------------- PARTNER FORM ------------------- */
app.post('/partner-form', upload.fields([
  { name: 'insuranceFile', maxCount: 1 },
  { name: 'regoFile', maxCount: 1 },
  { name: 'licenceFile', maxCount: 1 }
]), async (req, res) => {
  try {
    const data = req.body;
    const files = req.files;

    // Save to Supabase
    const insertData = {
      ...data,
      submittedAt: new Date().toISOString()
    };
    const { error } = await supabase.from('drivers').insert([insertData]);
    if (error) console.error('Supabase insert error:', error);

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
  } catch (err) {
    console.error('Partner form error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------- STRIPE CHECKOUT ------------------- */
app.post('/create-checkout-session', async (req, res) => {
  const {
    name, email, phone, pickup, dropoff, datetime,
    vehicleType, totalFare, distanceKm, durationMin,
    notes, hourlyNotes
  } = req.body;

  const finalNotes = hourlyNotes || notes || '';
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
      metadata: {
        name, email, phone, pickup, dropoff, datetime,
        vehicleType, totalFare: totalFare.toString(),
        notes: finalNotes,
        distanceKm: distanceKm ? distanceKm.toString() : 'N/A',
        durationMin: durationMin ? durationMin.toString() : 'N/A'
      },
      success_url: 'https://bookingform-pi.vercel.app/success.html',
      cancel_url: 'https://bookingform-pi.vercel.app/cancel.html'
    });
    res.status(200).json({ id: session.id, url: session.url });
  } catch (err) {
    res.status(500).json({ error: 'Stripe session creation failed.' });
  }
});

/* ------------------- STRIPE WEBHOOK ------------------- */
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const bookingId = Date.now().toString();
    const booking = {
      id: bookingId,
      name: s.metadata.name,
      email: s.metadata.email,
      phone: s.metadata.phone,
      pickup: s.metadata.pickup,
      dropoff: s.metadata.dropoff,
      datetime: s.metadata.datetime,
      vehicleType: s.metadata.vehicleType,
      totalFare: parseFloat(s.metadata.totalFare),
      distanceKm: s.metadata.distanceKm,
      durationMin: s.metadata.durationMin,
      notes: s.metadata.notes,
      paidAt: new Date().toISOString()
    };

    try {
      // Save booking to Supabase
      const { error } = await supabase.from('bookings').insert([booking]);
      if (error) console.error('Supabase booking insert error:', error);

      // Create driver job
      const driverPay = calculateDriverPayout(parseFloat(booking.totalFare));
      const job = {
        id: booking.id,
        driverEmail: '',
        bookingData: booking,
        driverPay,
        assignedAt: new Date().toISOString()
      };
      await supabase.from('driver_jobs').insert([job]);

      // Send emails & PDF invoice
      sendEmail(booking).catch(console.error);
      sendInvoicePDF(booking, s.id).catch(console.error);
    } catch (err) {
      console.error('Webhook booking error:', err);
    }
  }
  res.json({ received: true });
});

/* ------------------- HELPER FUNCTIONS ------------------- */
function calculateDriverPayout(clientFare) {
  return parseFloat((clientFare / 1.45).toFixed(2));
}

async function sendEmail(booking) {
  try {
    await transporter.sendMail({
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
    });
  } catch (err) { console.error('Email error:', err); }
}

async function sendInvoicePDF(booking, sessionId) {
  try {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const bufferStream = new streamBuffers.WritableStreamBuffer();
    doc.pipe(bufferStream);

    doc.fontSize(20).fillColor('#B9975B').text('CHAUFFEUR DE LUXE', { align: 'center' });
    doc.fontSize(12).fillColor('black').text('Driven by Distinction. Defined by Elegance.', { align: 'center' });
    doc.moveDown();
    doc.fontSize(18).text('Invoice', { align: 'center' });
    doc.moveDown();

    doc.fontSize(12)
      .text('Business Name: Chauffeur de Luxe')
      .text('ABN: ______________________ (to be filled)')
      .moveDown();

    doc.text(`Invoice Number: ${sessionId}`)
      .text(`Date: ${new Date().toLocaleDateString()}`)
      .moveDown();

    doc.text('Billed To:')
      .text(`Name: ${booking.name}`)
      .text(`Email: ${booking.email}`)
      .text(`Phone: ${booking.phone}`)
      .moveDown();

    doc.text(`Pickup: ${booking.pickup}`)
      .text(`Dropoff: ${booking.dropoff}`)
      .text(`Pickup Time: ${booking.datetime}`)
      .text(`Vehicle Type: ${booking.vehicleType}`)
      .moveDown();

    doc.text(`Distance: ${booking.distanceKm} km`)
      .text(`Estimated Duration: ${booking.durationMin} min`)
      .text(`Notes: ${booking.notes || 'None'}`)
      .moveDown();

    doc.fontSize(14).text(`Total Fare: $${booking.totalFare}`, { align: 'right' });
    doc.end();

    bufferStream.on('finish', async () => {
      const pdfBuffer = bufferStream.getContents();
      await transporter.sendMail({
        from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
        to: booking.email,
        subject: 'Your Chauffeur de Luxe Invoice',
        text: 'Please find your invoice attached.',
        attachments: [{ filename: 'invoice.pdf', content: pdfBuffer, contentType: 'application/pdf' }]
      });
    });
  } catch (err) {
    console.error('Invoice PDF error:', err);
  }
}

/* ------------------- DRIVER LOGIN ------------------- */
app.post('/driver-login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    // Fetch driver jobs
    const { data: jobs } = await supabase.from('driver_jobs').select('*').ilike('driverEmail', email);
    const { data: completed } = await supabase.from('completed_jobs').select('*').ilike('driverEmail', email);

    res.json({ jobs: jobs || [], completed: completed || [] });
  } catch (err) {
    console.error('Driver login error:', err);
    res.status(500).json({ error: 'Server error fetching driver jobs' });
  }
});

/* ------------------- PENDING BOOKINGS ------------------- */
app.get('/pending-bookings', async (req, res) => {
  try {
    const { data: bookings } = await supabase.from('bookings').select('*');
    const { data: driverJobs } = await supabase.from('driver_jobs').select('bookingData');
    const { data: completed } = await supabase.from('completed_jobs').select('id');

    const assignedIds = (driverJobs || []).map(j => j.bookingData.id);
    const completedIds = (completed || []).map(c => c.id);

    const pending = (bookings || []).filter(b => !assignedIds.includes(b.id) && !completedIds.includes(b.id));
    res.json(pending);
  } catch (err) {
    console.error('Pending bookings error:', err);
    res.status(500).json({ error: 'Server error fetching pending bookings' });
  }
});

/* ------------------- DRIVER RESPONSE ------------------- */
app.post('/driver-response', async (req, res) => {
  const { driverEmail, jobId, confirmed } = req.body;
  if (!driverEmail || !jobId || typeof confirmed !== 'boolean') 
    return res.status(400).json({ error: 'Missing required fields or invalid data' });

  try {
    const { data: jobs } = await supabase.from('driver_jobs').select('*').eq('id', jobId);
    if (!jobs || !jobs[0]) return res.status(404).json({ error: 'Job not found' });

    const jobData = jobs[0];

    if (confirmed) {
      await supabase.from('driver_jobs').update({ driverConfirmed: true, responseAt: new Date().toISOString() }).eq('id', jobId);
    } else {
      await supabase.from('driver_jobs').delete().eq('id', jobId);
    }

    await transporter.sendMail({
      from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO,
      subject: `Driver Job Response - ${confirmed ? 'CONFIRMED' : 'REFUSED'} - ${jobId}`,
      html: `
        <p>Driver <strong>${driverEmail}</strong> has <strong>${confirmed ? 'CONFIRMED ✅' : 'REFUSED ❌'}</strong> the job.</p>
        <p><strong>Name:</strong> ${jobData.bookingData.name}</p>
        <p><strong>Email:</strong> ${jobData.bookingData.email}</p>
        <p><strong>Phone:</strong> ${jobData.bookingData.phone}</p>
        <p><strong>Pickup:</strong> ${jobData.bookingData.pickup}</p>
        <p><strong>Dropoff:</strong> ${jobData.bookingData.dropoff}</p>
        <p><strong>Pickup Time:</strong> ${jobData.bookingData.datetime}</p>
        <p><strong>Vehicle Type:</strong> ${jobData.bookingData.vehicleType}</p>
        <p><strong>Driver Payout:</strong> $${jobData.driverPay.toFixed(2)}</p>
        <p><strong>Notes:</strong> ${jobData.bookingData.notes || 'None'}</p>
      `
    });

    res.json({ message: 'Driver response recorded successfully' });
  } catch (err) {
    console.error('Driver response error:', err);
    res.status(500).json({ error: 'Server error processing driver response' });
  }
});

/* ------------------- DRIVER COMPLETE ------------------- */
app.post('/driver-complete', async (req, res) => {
  const { driverEmail, jobId } = req.body;
  if (!driverEmail || !jobId) return res.status(400).json({ error: 'Missing required fields' });

  try {
    const { data: jobs } = await supabase.from('driver_jobs').select('*').eq('id', jobId);
    if (!jobs || !jobs[0]) return res.status(404).json({ error: 'Job not found' });

    const jobData = jobs[0];
    const completedJob = {
      id: jobData.id,
      driverEmail: jobData.driverEmail,
      bookingData: jobData.bookingData,
      driverPay: jobData.driverPay,
      assignedAt: jobData.assignedAt,
      completedAt: new Date().toISOString()
    };

    await supabase.from('completed_jobs').upsert([completedJob], { onConflict: ['id'] });
    await supabase.from('driver_jobs').delete().eq('id', jobId);

    await transporter.sendMail({
      from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO,
      subject: `Driver Job Completed - ${jobId}`,
      html: `
        <p>Driver <strong>${driverEmail}</strong> has <strong>COMPLETED ✅</strong> the job <strong>${jobId}</strong>.</p>
        <p><strong>Name:</strong> ${jobData.bookingData.name}</p>
        <p><strong>Email:</strong> ${jobData.bookingData.email}</p>
        <p><strong>Phone:</strong> ${jobData.bookingData.phone}</p>
        <p><strong>Pickup:</strong> ${jobData.bookingData.pickup}</p>
        <p><strong>Dropoff:</strong> ${jobData.bookingData.dropoff}</p>
        <p><strong>Pickup Time:</strong> ${jobData.bookingData.datetime}</p>
        <p><strong>Vehicle Type:</strong> ${jobData.bookingData.vehicleType}</p>
        <p><strong>Driver Payout:</strong> $${jobData.driverPay.toFixed(2)}</p>
        <p><strong>Notes:</strong> ${jobData.bookingData.notes || 'None'}</p>
      `
    });

    res.json({ message: 'Job marked as completed successfully' });
  } catch (err) {
    console.error('Driver complete error:', err);
    res.status(500).json({ error: 'Server error completing job' });
  }
});

/* ------------------- DRIVER HISTORY ------------------- */
app.post('/driver-history', async (req, res) => {
  const { driverEmail } = req.body;
  if (!driverEmail) return res.status(400).json({ error: 'Email required' });

  try {
    const { data } = await supabase.from('completed_jobs').select('*').ilike('driverEmail', driverEmail).order('completedAt', { ascending: false });
    res.json(data || []);
  } catch (err) {
    console.error('Driver history error:', err);
    res.status(500).json({ error: 'Server error fetching driver history' });
  }
});

/* ------------------- START SERVER ------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
