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

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

/* ------------------- MULTER ------------------- */
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

/* ------------------- PARTNER FORM ------------------- */
app.post('/partner-form', upload.fields([
  { name: 'insuranceFile', maxCount: 1 },
  { name: 'regoFile', maxCount: 1 },
  { name: 'licenceFile', maxCount: 1 }
]), async (req, res) => {
  try {
    const data = req.body;
    const files = req.files;

    let drivers = [];
    const dataPath = path.join(__dirname, 'drivers.json');
    if (fs.existsSync(dataPath)) drivers = JSON.parse(fs.readFileSync(dataPath));
    drivers.push({ ...data, files, submittedAt: new Date() });
    fs.writeFileSync(dataPath, JSON.stringify(drivers, null, 2));

    const attachments = [];
    for (let field in files) {
      attachments.push({ filename: files[field][0].originalname, path: files[field][0].path });
    }

    await transporter.sendMail({
      from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO,
      subject: `New Driver Partner Submission - ${data.fullName}`,
      html: `<h2>Driver Partner Application</h2><p>Name: ${data.fullName}</p><p>Email: ${data.email}</p>`,
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
  const { name, email, phone, pickup, dropoff, datetime, vehicleType, totalFare, distanceKm, durationMin, notes } = req.body;

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
          product_data: { name: `Chauffeur Booking – ${vehicleType.toUpperCase()}` },
          unit_amount: Math.round(totalFare * 100)
        },
        quantity: 1
      }],
      metadata: { name, email, phone, pickup, dropoff, datetime, vehicleType, totalFare: totalFare.toString(), distanceKm: distanceKm.toString(), durationMin: durationMin.toString(), notes: notes || '' },
      success_url: 'https://bookingform-pi.vercel.app/success.html',
      cancel_url: 'https://bookingform-pi.vercel.app/cancel.html'
    });

    res.status(200).json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
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
    const session = event.data.object;

    const booking = {
      id: Date.now(),
      customername: session.metadata.name,
      customeremail: session.metadata.email,
      customerphone: session.metadata.phone,
      pickup: session.metadata.pickup,
      dropoff: session.metadata.dropoff,
      pickuptime: session.metadata.datetime,
      vehicletype: session.metadata.vehicleType,
      fare: parseFloat(session.metadata.totalFare),
      distance_km: parseFloat(session.metadata.distanceKm),
      duration_min: parseFloat(session.metadata.durationMin),
      notes: session.metadata.notes,
      status: 'pending',
      createdat: new Date().toISOString(),
      assignedto: null,
      assignedat: null
    };

    try {
      const { data, error } = await supabase.from('pending_jobs').insert([booking]);
      if (error) console.error('Supabase insert error:', error);

      await sendEmail(booking);
      await sendInvoicePDF(booking, session.id);
    } catch (err) { console.error('Webhook insert error:', err); }
  }

  res.status(200).json({ received: true });
});

/* ------------------- EMAIL FUNCTIONS ------------------- */
async function sendEmail(booking) {
  try {
    await transporter.sendMail({
      from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO,
      subject: `New Booking from ${booking.customername}`,
      html: `<p>Name: ${booking.customername}</p><p>Pickup: ${booking.pickup}</p><p>Dropoff: ${booking.dropoff}</p>`
    });
  } catch (err) { console.error('Email error:', err); }
}

async function sendInvoicePDF(booking, sessionId) {
  try {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const bufferStream = new streamBuffers.WritableStreamBuffer();
    doc.pipe(bufferStream);
    doc.fontSize(20).fillColor('#B9975B').text('CHAUFFEUR DE LUXE', { align: 'center' });
    doc.fontSize(18).fillColor('black').text('Invoice', { align: 'center' });
    doc.end();

    bufferStream.on('finish', async () => {
      const pdfBuffer = bufferStream.getContents();
      await transporter.sendMail({
        from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
        to: booking.customeremail,
        subject: 'Your Invoice',
        text: 'Please find your invoice attached.',
        attachments: [{ filename: 'invoice.pdf', content: pdfBuffer, contentType: 'application/pdf' }]
      });
    });
  } catch (err) { console.error('Invoice PDF error:', err); }
}

// ------------------- PART 2: ASSIGN JOB, DRIVER LOGIN & COMPLETED JOBS -------------------

// ------------------- ASSIGN JOB -------------------
app.post('/assign-job', async (req, res) => {
  try {
    const { bookingData } = req.body;
    if (!bookingData || !bookingData.id || !bookingData.assignedto) {
      return res.status(400).json({ error: 'Missing booking ID or driver email' });
    }

    // Fetch pending job
    const { data: pendingData, error: fetchError } = await supabase
      .from('pending_jobs')
      .select('*')
      .eq('id', bookingData.id)
      .single();

    if (fetchError || !pendingData) return res.status(404).json({ error: 'Booking not found' });

    const driverPay = pendingData.fare * 0.8;

    // Insert into completed_jobs
    const { error: insertError } = await supabase.from('completed_jobs').insert([{
      ...pendingData,
      assignedto: bookingData.assignedto,
      driverPay,
      assignedat: new Date().toISOString(),
      status: 'completed'
    }]);
    if (insertError) return res.status(500).json({ error: 'Error assigning job' });

    // Delete from pending_jobs
    await supabase.from('pending_jobs').delete().eq('id', bookingData.id);

    // Notify driver via email
    await transporter.sendMail({
      from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
      to: bookingData.assignedto,
      subject: `New Chauffeur Job Assigned`,
      html: `<p>You have a new job assigned.</p>
             <p>Pickup: ${pendingData.pickup}<br>
             Dropoff: ${pendingData.dropoff}<br>
             Fare: $${driverPay}</p>`
    });

    res.json({ message: 'Job assigned successfully' });
  } catch (err) {
    console.error('Assign job error:', err);
    res.status(500).json({ error: 'Server error in /assign-job' });
  }
});

// ------------------- DRIVER LOGIN -------------------
app.post('/driver-login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const { data: pendingJobs } = await supabase
      .from('pending_jobs')
      .select('*')
      .eq('assignedto', email);

    const { data: completedJobs } = await supabase
      .from('completed_jobs')
      .select('*')
      .eq('assignedto', email);

    res.json({ jobs: pendingJobs || [], completed: completedJobs || [] });
  } catch (err) {
    console.error('Driver login error:', err);
    res.status(500).json({ error: 'Failed to fetch driver jobs' });
  }
});

// ------------------- GET PENDING JOBS -------------------
app.get('/pending-jobs', async (req, res) => {
  try {
    const { data, error } = await supabase.from('pending_jobs').select('*').order('createdat', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed to fetch pending jobs' });
    res.json(data);
  } catch (err) {
    console.error('Pending jobs error:', err);
    res.status(500).json({ error: 'Server error fetching pending jobs' });
  }
});

// ------------------- GET COMPLETED JOBS -------------------
app.get('/completed-jobs', async (req, res) => {
  try {
    const { data, error } = await supabase.from('completed_jobs').select('*').order('assignedat', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed to fetch completed jobs' });
    res.json(data);
  } catch (err) {
    console.error('Completed jobs error:', err);
    res.status(500).json({ error: 'Server error fetching completed jobs' });
  }
});

// ------------------- PART 3: DRIVER RENEWALS CRON & SERVER START -------------------

// ------------------- CRON JOB FOR DRIVER RENEWALS -------------------
cron.schedule('0 9 * * *', () => {
  const dataPath = path.join(__dirname, 'drivers.json');
  if (!fs.existsSync(dataPath)) return;

  const drivers = JSON.parse(fs.readFileSync(dataPath));
  const today = new Date();

  drivers.forEach(driver => {
    const regoDate = new Date(driver.regoExpiry);
    const insuranceDate = new Date(driver.insuranceExpiry);

    [{ type: 'Registration', date: regoDate }, { type: 'Insurance', date: insuranceDate }].forEach(item => {
      const diffDays = Math.ceil((item.date - today) / (1000 * 60 * 60 * 24));
      if (diffDays === 30) {
        transporter.sendMail({
          from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
          to: process.env.EMAIL_TO,
          subject: `${item.type} Renewal Reminder - ${driver.fullName}`,
          text: `${driver.fullName}'s ${item.type} expires in 30 days on ${item.date.toDateString()}.`
        }).catch(console.error);
      }
    });
  });
});

// ------------------- START SERVER -------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
