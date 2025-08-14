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

const app = express();

app.use(cors());
app.use(express.static('public'));

// Multer setup
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

// Nodemailer setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// Partner form route
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

// Body parsers AFTER multipart routes
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(bodyParser.json());

// Booking email function
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

// Generate PDF Invoice and email client
async function sendInvoicePDF(booking, sessionId) {
  try {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const bufferStream = new streamBuffers.WritableStreamBuffer();
    doc.pipe(bufferStream);

    doc
      .fontSize(20)
      .fillColor('#B9975B')
      .text('CHAUFFEUR DE LUXE', { align: 'center' });
    doc
      .fontSize(12)
      .fillColor('black')
      .text('Driven by Distinction. Defined by Elegance.', { align: 'center' });
    doc.moveDown();

    doc
      .fontSize(18)
      .fillColor('black')
      .text('Invoice', { align: 'center' });
    doc.moveDown();

    doc
      .fontSize(12)
      .text('Business Name: Chauffeur de Luxe')
      .text('ABN: ______________________ (to be filled)')
      .moveDown();

    doc
      .fontSize(12)
      .text(`Invoice Number: ${sessionId}`)
      .text(`Date: ${new Date().toLocaleDateString()}`)
      .moveDown();

    doc
      .fontSize(12)
      .text(`Billed To:`)
      .text(`Name: ${booking.name}`)
      .text(`Email: ${booking.email}`)
      .text(`Phone: ${booking.phone}`)
      .moveDown();

    doc
      .text(`Pickup: ${booking.pickup}`)
      .text(`Dropoff: ${booking.dropoff}`)
      .text(`Pickup Time: ${booking.datetime}`)
      .text(`Vehicle Type: ${booking.vehicleType}`)
      .moveDown();

    doc
      .text(`Distance: ${booking.distanceKm} km`)
      .text(`Estimated Duration: ${booking.durationMin} min`)
      .text(`Notes: ${booking.notes || 'None'}`)
      .moveDown();

    doc
      .fontSize(14)
      .text(`Total Fare: $${booking.totalFare}`, { align: 'right' });

    doc.end();

    bufferStream.on('finish', async () => {
      const pdfBuffer = bufferStream.getContents();
      await transporter.sendMail({
        from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
        to: booking.email,
        subject: 'Your Chauffeur de Luxe Invoice',
        text: 'Please find your invoice attached.',
        attachments: [
          { filename: 'invoice.pdf', content: pdfBuffer, contentType: 'application/pdf' }
        ]
      });
    });
  } catch (err) {
    console.error('Invoice PDF sending error:', err);
  }
}

// Booking routes
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

// Stripe webhook
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
    sendInvoicePDF({
      name: s.metadata.name, email: s.metadata.email, phone: s.metadata.phone, pickup: s.metadata.pickup, dropoff: s.metadata.dropoff, datetime: s.metadata.datetime, vehicleType: s.metadata.vehicleType, totalFare: s.metadata.totalFare, distanceKm: s.metadata.distanceKm, durationMin: s.metadata.durationMin, notes: s.metadata.notes
    }, s.id);
  }
  res.json({ received: true });
});

// Renewal reminder
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

/* ------------------- DRIVER JOB ASSIGNMENT FEATURE ------------------- */

function calculateDriverPayout(clientFare) {
  const net = clientFare / 1.45;
  return parseFloat(net.toFixed(2));
}

app.post('/assign-job', (req, res) => {
  const { driverEmail, bookingData } = req.body;
  if (!driverEmail || !bookingData) return res.status(400).json({ error: 'Missing driverEmail or bookingData' });

  const jobsFile = path.join(__dirname, 'driver-jobs.json');
  let jobs = [];
  if (fs.existsSync(jobsFile)) {
    jobs = JSON.parse(fs.readFileSync(jobsFile));
  }

  const driverPay = calculateDriverPayout(parseFloat(bookingData.totalFare));

  const newJob = {
    id: Date.now().toString(),
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
      <p><strong>Pickup:</strong> ${bookingData.pickup}</p>
      <p><strong>Dropoff:</strong> ${bookingData.dropoff}</p>
      <p><strong>Pickup Time:</strong> ${bookingData.datetime}</p>
      <p><strong>Vehicle Type:</strong> ${bookingData.vehicleType}</p>
      <p><strong>Driver Payout:</strong> $${driverPay}</p>
      <p><strong>Notes:</strong> ${bookingData.notes || 'None'}</p>
      <p>Please login to your driver dashboard to view full details.</p>
    `
  }).catch(err => console.error('Error sending job email to driver:', err));

  res.json({ message: 'Job assigned successfully', jobId: newJob.id });
});

app.post('/driver-login', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const jobsFile = path.join(__dirname, 'driver-jobs.json');
  let jobs = [];
  if (fs.existsSync(jobsFile)) jobs = JSON.parse(fs.readFileSync(jobsFile));
  const driverJobs = jobs.filter(job => job.driverEmail.toLowerCase() === email.toLowerCase());

  res.json({ jobs: driverJobs });
});

/* ------------------- PENDING BOOKINGS ROUTE ------------------- */

app.get('/pending-bookings', (req, res) => {
  const jobsFile = path.join(__dirname, 'driver-jobs.json');
  let jobs = [];
  if (fs.existsSync(jobsFile)) jobs = JSON.parse(fs.readFileSync(jobsFile));

  // Only return unassigned jobs (no driverEmail)
  const pending = jobs.filter(j => !j.driverEmail).map(j => j.bookingData);
  res.json(pending);
});

/* ------------------- ADMIN PANEL ROUTES ------------------- */

app.get('/drivers', (req, res) => {
  const dataPath = path.join(__dirname, 'drivers.json');
  if (!fs.existsSync(dataPath)) return res.json([]);
  const drivers = JSON.parse(fs.readFileSync(dataPath));
  res.json(drivers);
});

app.delete('/drivers/:email', (req, res) => {
  const email = req.params.email.toLowerCase();
  const dataPath = path.join(__dirname, 'drivers.json');
  if (!fs.existsSync(dataPath)) return res.status(404).json({ error: 'No drivers found' });

  let drivers = JSON.parse(fs.readFileSync(dataPath));
  const newDrivers = drivers.filter(d => d.email.toLowerCase() !== email);
  fs.writeFileSync(dataPath, JSON.stringify(newDrivers, null, 2));

  res.json({ message: `Driver with email ${email} deleted` });
});

app.get('/jobs', (req, res) => {
  const jobsFile = path.join(__dirname, 'driver-jobs.json');
  if (!fs.existsSync(jobsFile)) return res.json([]);
  const jobs = JSON.parse(fs.readFileSync(jobsFile));
  res.json(jobs);
});

app.delete('/jobs/:id', (req, res) => {
  const jobId = req.params.id;
  const jobsFile = path.join(__dirname, 'driver-jobs.json');
  if (!fs.existsSync(jobsFile)) return res.status(404).json({ error: 'No jobs found' });

  let jobs = JSON.parse(fs.readFileSync(jobsFile));
  const newJobs = jobs.filter(j => j.id !== jobId);
  fs.writeFileSync(jobsFile, JSON.stringify(newJobs, null, 2));

  res.json({ message: `Job with ID ${jobId} deleted` });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
