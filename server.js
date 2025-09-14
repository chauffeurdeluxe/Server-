require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const multer = require('multer');
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

/* ------------------- NODEMAILER ------------------- */
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

/* ------------------- MULTER SETUP ------------------- */
const storage = multer.memoryStorage();
const upload = multer({ storage });

/* ------------------- HELPER FUNCTIONS ------------------- */
async function sendEmail(booking) {
  try {
    await transporter.sendMail({
      from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO,
      subject: `New Booking Paid - ${booking.name}`,
      html: `<p>Booking details:</p><pre>${JSON.stringify(booking, null, 2)}</pre>`
    });
  } catch (err) {
    console.error('Send email error:', err);
  }
}

async function sendInvoicePDF(booking, sessionId) {
  try {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const bufferStream = new streamBuffers.WritableStreamBuffer();
    doc.pipe(bufferStream);

    doc.fontSize(20).fillColor('#B9975B').text('CHAUFFEUR DE LUXE', { align: 'center' });
    doc.fontSize(12).fillColor('black').text('Driven by Distinction. Defined by Elegance.', { align: 'center' });
    doc.moveDown();
    doc.fontSize(18).fillColor('black').text('Invoice', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Invoice Number: ${sessionId}`);
    doc.text(`Date: ${new Date().toLocaleDateString()}`);
    doc.moveDown();
    doc.text(`Billed To: ${booking.name} (${booking.email})`);
    doc.text(`Phone: ${booking.phone}`);
    doc.moveDown();
    doc.text(`Pickup: ${booking.pickup}`);
    doc.text(`Dropoff: ${booking.dropoff}`);
    doc.text(`Pickup Time: ${booking.datetime}`);
    doc.text(`Vehicle Type: ${booking.vehicleType}`);
    doc.moveDown();
    doc.text(`Distance: ${booking.distanceKm} km`);
    doc.text(`Estimated Duration: ${booking.durationMin} min`);
    doc.text(`Notes: ${booking.notes || 'None'}`);
    doc.moveDown();
    doc.fontSize(14).text(`Total Fare: $${booking.totalFare}`, { align: 'right' });

    doc.end();

    bufferStream.on('finish', async () => {
      const pdfBuffer = bufferStream.getContents();
      await transporter.sendMail({
        from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
        to: booking.email,
        subject: 'Your Chauffeur Booking Invoice',
        text: 'Please find attached your invoice.',
        attachments: [{ filename: `invoice-${sessionId}.pdf`, content: pdfBuffer }]
      });
    });
  } catch (err) {
    console.error('Send PDF invoice error:', err);
  }
}

/* ------------------- PARTNER FORM ------------------- */
app.post('/partner-form', upload.fields([
  { name: 'insuranceFile', maxCount: 1 },
  { name: 'regoFile', maxCount: 1 },
  { name: 'licenceFile', maxCount: 1 }
]), async (req, res) => {
  try {
    const data = req.body;
    const files = req.files;

    const fileData = {};
    for (let key in files) {
      fileData[key] = {
        filename: files[key][0].originalname,
        buffer: files[key][0].buffer
      };
    }

    await supabase.from('drivers').insert([{
      ...data,
      files: fileData,
      submittedAt: new Date().toISOString()
    }]);

    const attachments = Object.values(files).map(f => ({
      filename: f[0].originalname,
      content: f[0].buffer
    }));

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

    res.json({ message: 'Driver partner submitted successfully' });
  } catch (err) {
    console.error('Partner form error:', err);
    res.status(500).json({ error: 'Server error submitting partner form' });
  }
});

/* ------------------- STRIPE CHECKOUT ------------------- */
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { name, email, phone, pickup, dropoff, datetime, vehicleType, totalFare, distanceKm, durationMin, notes, hourlyNotes } = req.body;
    const finalNotes = hourlyNotes || notes || '';

    if (!email || !totalFare || totalFare < 10) return res.status(400).json({ error: 'Invalid booking data.' });

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
        name, email, phone, pickup, dropoff, datetime, vehicleType,
        totalFare: totalFare.toString(), notes: finalNotes,
        distanceKm: distanceKm ? distanceKm.toString() : 'N/A',
        durationMin: durationMin ? durationMin.toString() : 'N/A'
      },
      success_url: 'https://bookingform-pi.vercel.app/success.html',
      cancel_url: 'https://bookingform-pi.vercel.app/cancel.html'
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Stripe session creation failed' });
  }
});

/* ------------------- STRIPE WEBHOOK ------------------- */
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
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

    // Save booking to Supabase
    await supabase.from('bookings').insert([booking]);

    // Add to driver jobs
    const driverPay = parseFloat((booking.totalFare / 1.45).toFixed(2));
    await supabase.from('driver_jobs').insert([{
      id: booking.id,
      driverEmail: '',
      bookingData: booking,
      driverPay,
      assignedAt: new Date().toISOString()
    }]);

    // Send emails & invoice
    sendEmail(booking).catch(console.error);
    sendInvoicePDF(booking, s.id).catch(console.error);
  }

  res.json({ received: true });
});

/* ------------------- DRIVER JOBS ------------------- */
app.post('/assign-job', async (req, res) => {
  const { driverEmail, bookingId } = req.body;
  if (!driverEmail || !bookingId) return res.status(400).json({ error: 'Missing driverEmail or bookingId' });

  const { data: booking } = await supabase.from('bookings').select('*').eq('id', bookingId).single();
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const driverPay = parseFloat((booking.totalFare / 1.45).toFixed(2));
  const newJob = {
    id: booking.id,
    driverEmail,
    bookingData: booking,
    driverPay,
    assignedAt: new Date().toISOString()
  };

  await supabase.from('driver_jobs').insert([newJob]);

  transporter.sendMail({
    from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
    to: driverEmail,
    subject: `New Chauffeur Job Assigned`,
    html: `<h2>You have a new job assigned</h2><pre>${JSON.stringify(booking, null, 2)}</pre>`
  }).catch(console.error);

  res.json({ message: 'Job assigned successfully' });
});

/* ------------------- DRIVER RESPONSE ------------------- */
app.post('/driver-response', async (req, res) => {
  const { driverEmail, jobId, confirmed } = req.body;
  if (!driverEmail || !jobId || typeof confirmed !== 'boolean') return res.status(400).json({ error: 'Missing fields' });

  const { data: job } = await supabase.from('driver_jobs').select('*').eq('id', jobId).single();
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (confirmed) {
    await supabase.from('driver_jobs').update({ driverConfirmed: true, responseAt: new Date().toISOString() }).eq('id', jobId);
  } else {
    await supabase.from('driver_jobs').delete().eq('id', jobId);
  }

  transporter.sendMail({
    from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
    to: process.env.EMAIL_TO,
    subject: `Driver Job Response - ${confirmed ? 'CONFIRMED' : 'REFUSED'} - ${jobId}`,
    html: `<pre>${JSON.stringify(job, null, 2)}</pre>`
  }).catch(console.error);

  res.json({ message: 'Driver response recorded' });
});

/* ------------------- DRIVER COMPLETE ------------------- */
app.post('/driver-complete', async (req, res) => {
  const { driverEmail, jobId } = req.body;
  if (!driverEmail || !jobId) return res.status(400).json({ error: 'Missing fields' });

  const { data: job } = await supabase.from('driver_jobs').select('*').eq('id', jobId).single();
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const completedJob = {
    ...job,
    completed: true,
    completedAt: new Date().toISOString()
  };

  await supabase.from('completed_jobs').upsert([completedJob], { onConflict: ['id'] });
  await supabase.from('driver_jobs').delete().eq('id', jobId);

  transporter.sendMail({
    from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
    to: process.env.EMAIL_TO,
    subject: `Driver Job Completed - ${jobId}`,
    html: `<pre>${JSON.stringify(job, null, 2)}</pre>`
  }).catch(console.error);

  res.json({ message: 'Job marked as completed' });
});

/* ------------------- DRIVER HISTORY ------------------- */
app.post('/driver-history', async (req, res) => {
  const { driverEmail } = req.body;
  if (!driverEmail) return res.status(400).json({ error: 'Email required' });

  const { data } = await supabase.from('completed_jobs').select('*').ilike('driverEmail', driverEmail).order('completedAt', { ascending: false });
  res.json(data || []);
});

/* ------------------- PENDING BOOKINGS ------------------- */
app.get('/pending-bookings', async (req, res) => {
  const { data: bookings } = await supabase.from('bookings').select('*');
  const { data: jobs } = await supabase.from('driver_jobs').select('*');
  const { data: completed } = await supabase.from('completed_jobs').select('id');

  const assignedIds = (jobs || []).map(j => j.id);
  const completedIds = (completed || []).map(c => c.id);

  const pending = (bookings || []).filter(b => !assignedIds.includes(b.id) && !completedIds.includes(b.id));
  res.json(pending);
});

/* ------------------- COMPLETED JOBS ------------------- */
app.get('/completed-jobs', async (req, res) => {
  const { data } = await supabase.from('completed_jobs').select('*');
  res.json(data || []);
});

/* ------------------- DRIVERS ------------------- */
app.get('/drivers', async (req, res) => {
  const { data } = await supabase.from('drivers').select('*');
  res.json(data || []);
});

app.delete('/drivers/:email', async (req, res) => {
  const email = req.params.email.toLowerCase();
  await supabase.from('drivers').delete().ilike('email', email);
  res.json({ message: `Driver with email ${email} deleted` });
});

/* ------------------- DRIVER LOGIN ------------------- */
app.post('/driver-login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const { data: driverJobs } = await supabase.from('driver_jobs').select('*').ilike('driverEmail', email);
  const { data: completedJobs } = await supabase.from('completed_jobs').select('*').ilike('driverEmail', email);

  res.json({ jobs: driverJobs || [], completed: completedJobs || [] });
});

/* ------------------- RENEWAL REMINDERS ------------------- */
const cron = require('node-cron');
cron.schedule('0 9 * * *', async () => {
  try {
    const { data: drivers } = await supabase.from('drivers').select('*');
    if (!drivers) return;

    const today = new Date();
    for (const driver of drivers) {
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
              text: `${driver.fullName}'s ${item.type.toLowerCase()} expires in 30 days on ${item.date.toDateString()}.`
            }).catch(console.error);
          }
        });
    }
  } catch (err) {
    console.error('Renewal reminder error:', err);
  }
});

/* ------------------- START SERVER ------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
