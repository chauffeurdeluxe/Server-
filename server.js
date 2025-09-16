require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
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

/* ------------------- HELPER: SAVE COMPLETED JOB ------------------- */
async function saveCompletedJob(job) {
  const { error } = await supabase.from('completed_jobs').insert([job]);
  if (error) console.error('Supabase insert error:', error);
}

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

/* ------------------- PARTNER FORM ROUTE ------------------- */
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
    const driverRecord = { ...data, files, submittedAt: new Date() };
    drivers.push(driverRecord);
    fs.writeFileSync(dataPath, JSON.stringify(drivers, null, 2));

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

/* ------------------- STRIPE WEBHOOK ------------------- */
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log('Webhook received:', event.type);
  } catch (err) {
    console.error('⚠️ Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    console.log('✅ Payment completed webhook received');

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
      paidAt: new Date()
    };

    const bookingsFile = path.join(__dirname, 'bookings.json');
    let allBookings = [];
    if (fs.existsSync(bookingsFile)) allBookings = JSON.parse(fs.readFileSync(bookingsFile));
    allBookings.push(booking);
    fs.writeFileSync(bookingsFile, JSON.stringify(allBookings, null, 2));
    console.log('✅ Booking saved:', booking.id);

    // Add booking to Supabase pending table
try {
  const { data: pendingData, error: pendingError } = await supabase
    .from('pending_bookings')      // <-- replace with your actual pending table name
    .insert([{
      id: booking.id,
      name: booking.name,
      email: booking.email,
      phone: booking.phone,
      pickup: booking.pickup,
      dropoff: booking.dropoff,
      datetime: booking.datetime,
      vehicleType: booking.vehicleType,
      totalFare: booking.totalFare,
      distanceKm: booking.distanceKm,
      durationMin: booking.durationMin,
      notes: booking.notes || '',
      created_at: new Date()
    }]);

  if (pendingError) console.error('Supabase pending insert error:', pendingError);
  else console.log('✅ Booking added to Supabase pending_bookings:', booking.id);
} catch (err) {
  console.error('Supabase pending insert exception:', err);
}

    // Add to driver jobs
    const jobsFile = path.join(__dirname, 'driver-jobs.json');
    let jobs = [];
    if (fs.existsSync(jobsFile)) jobs = JSON.parse(fs.readFileSync(jobsFile));

    const driverPay = calculateDriverPayout(parseFloat(booking.totalFare));

    const newJob = {
      id: booking.id,
      driverEmail: '',
      bookingData: booking,
      driverPay,
      assignedAt: new Date()
    };

    jobs.push(newJob);
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
    console.log('✅ Booking also added to driver-jobs.json:', newJob.id);

    sendEmail(booking).catch(console.error);
    sendInvoicePDF(booking, s.id).catch(console.error);
  }

  res.json({ received: true });
});

/* ------------------- BODY PARSERS ------------------- */
app.use(bodyParser.json());

/* ------------------- EMAIL & PDF FUNCTIONS ------------------- */
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
  } catch (err) {
    console.error('Email error:', err);
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

/* ------------------- STRIPE CHECKOUT SESSION ------------------- */
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
    distanceKm,
    durationMin,
    notes,
    hourlyNotes
  } = req.body;

  const finalNotes = hourlyNotes || notes || '';

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
      metadata: {
        name,
        email,
        phone,
        pickup,
        dropoff,
        datetime,
        vehicleType,
        totalFare: totalFare.toString(),
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

/* ------------------- DRIVER JOB LOGIC ------------------- */
function calculateDriverPayout(clientFare) {
  const net = clientFare / 1.45;
  return parseFloat(net.toFixed(2));
}

app.post('/assign-job', (req, res) => {
  const { driverEmail, bookingData } = req.body;
  if (!driverEmail || !bookingData) return res.status(400).json({ error: 'Missing driverEmail or bookingData' });

  const jobsFile = path.join(__dirname, 'driver-jobs.json');
  let jobs = [];
  if (fs.existsSync(jobsFile)) jobs = JSON.parse(fs.readFileSync(jobsFile));

  const driverPay = calculateDriverPayout(parseFloat(bookingData.totalFare));

  const newJob = {
    id: bookingData.id,
    driverEmail,
    bookingData,
    driverPay,
    assignedAt: new Date()
  };

  jobs.push(newJob);
  fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));

  transporter.sendMail({
    from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
    to: driverEmail,
    subject: `New Chauffeur Job Assigned`,
    html: `
      <h2>You have a new job assigned</h2>
      <p><strong>Name:</strong> ${bookingData.name}</p>
      <p><strong>Email:</strong> ${bookingData.email}</p>
      <p><strong>Phone:</strong> ${bookingData.phone}</p>
      <p><strong>Pickup:</strong> ${bookingData.pickup}</p>
      <p><strong>Dropoff:</strong> ${bookingData.dropoff}</p>
      <p><strong>Pickup Time:</strong> ${bookingData.datetime}</p>
      <p><strong>Vehicle Type:</strong> ${bookingData.vehicleType}</p>
      <p><strong>Driver Payout:</strong> $${driverPay}</p>
      <p><strong>Notes:</strong> ${bookingData.notes || 'None'}</p>
      <p>Please login to your driver dashboard to view full details.</p>
    `
  }).catch(console.error);

  res.json({ message: 'Job assigned successfully', jobId: newJob.id });
});

/* ------------------- PENDING BOOKINGS ROUTE ------------------- */
app.get('/pending-bookings', async (req, res) => {
  try {
    const bookingsFile = path.join(__dirname, 'bookings.json');
    let bookings = [];
    if (fs.existsSync(bookingsFile)) bookings = JSON.parse(fs.readFileSync(bookingsFile));

    const jobsFile = path.join(__dirname, 'driver-jobs.json');
    let jobs = [];
    if (fs.existsSync(jobsFile)) jobs = JSON.parse(fs.readFileSync(jobsFile));

    const assignedBookingIds = jobs
      .filter(j => j.driverEmail && j.driverEmail.trim() !== '')
      .map(j => j.bookingData.id.toString());

    const { data: completed, error } = await supabase.from('completed_jobs').select('id');
    if (error) {
      console.error('Error fetching completed jobs:', error);
      return res.status(500).json({ error: 'Failed to fetch completed jobs' });
    }
    const completedBookingIds = (completed || []).map(c => c.id.toString());

    const pending = bookings.filter(
      b => !assignedBookingIds.includes(b.id.toString()) && !completedBookingIds.includes(b.id.toString())
    );

    res.json(pending);
  } catch (err) {
    console.error('Pending bookings error:', err);
    res.status(500).json({ error: 'Server error fetching pending bookings' });
  }
});

/* ------------------- DRIVER LOGIN ------------------- */
app.post('/driver-login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password' });
  }

  try {
    const { data: driver, error } = await supabase
      .from('drivers')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !driver) {
      return res.status(401).json({ error: 'Invalid login credentials' });
    }

    // NOTE: Replace with bcrypt compare if passwords are hashed
    if (driver.passwordhash !== password) {
      return res.status(401).json({ error: 'Invalid login credentials' });
    }

    // Update last login
    await supabase
      .from('drivers')
      .update({ lastlogin: new Date() })
      .eq('id', driver.id);

    res.json({ message: 'Login successful', driver });
  } catch (err) {
    console.error('Driver login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

/* ------------------- COMPLETE JOB ROUTE ------------------- */
app.post('/complete-job', async (req, res) => {
  const { jobId, driverEmail } = req.body;

  if (!jobId || !driverEmail) {
    return res.status(400).json({ error: 'Missing jobId or driverEmail' });
  }

  try {
    // Load driver jobs
    const jobsFile = path.join(__dirname, 'driver-jobs.json');
    let jobs = [];
    if (fs.existsSync(jobsFile)) {
      jobs = JSON.parse(fs.readFileSync(jobsFile));
    }

    const jobIndex = jobs.findIndex(j => j.id.toString() === jobId.toString());
    if (jobIndex === -1) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = jobs[jobIndex];
    if (job.driverEmail !== driverEmail) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const completedJob = {
      id: job.id,
      driverEmail: job.driverEmail,
      driverPay: job.driverPay,
      assignedat: job.assignedAt,
      completedAt: new Date(),
      customername: job.bookingData.name,
      customeremail: job.bookingData.email,
      customerphone: job.bookingData.phone,
      pickup: job.bookingData.pickup,
      dropoff: job.bookingData.dropoff,
      pickuptime: job.bookingData.datetime,
      vehicletype: job.bookingData.vehicleType,
      fare: job.bookingData.totalFare,
      status: 'completed',
      createdat: new Date(),
      assignedto: job.driverEmail,
      distance_km: job.bookingData.distanceKm,
      duration_min: job.bookingData.durationMin,
      notes: job.bookingData.notes || ''
    };

    // Save to Supabase
    const { error } = await supabase.from('completed_jobs').insert([completedJob]);
    if (error) {
      console.error('Supabase error saving completed job:', error);
      return res.status(500).json({ error: 'Failed to save completed job' });
    }

    // Remove from driver-jobs.json
    jobs.splice(jobIndex, 1);
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));

    res.json({ message: 'Job completed successfully' });
  } catch (err) {
    console.error('Complete job error:', err);
    res.status(500).json({ error: 'Server error completing job' });
  }
});

/* ------------------- START SERVER ------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = app;
