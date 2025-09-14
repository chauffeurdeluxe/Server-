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

/* ------------------- STRIPE CHECKOUT SESSION ------------------- */
app.post('/create-checkout-session', async (req, res) => {
  const {
    name, email, phone, pickup, dropoff, datetime,
    vehicleType, totalFare, distanceKm, durationMin,
    notes, hourlyNotes
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
    console.log('Webhook received:', event.type);
  } catch (err) {
    console.error('⚠️ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    console.log('✅ Payment completed webhook received');

    const session = event.data.object;

    const totalFare = parseFloat(session.metadata.totalFare) || 0;
    const distanceKm = parseFloat(session.metadata.distanceKm) || 0;
    const durationMin = parseFloat(session.metadata.durationMin) || 0;
    const datetime = session.metadata.datetime ? new Date(session.metadata.datetime) : new Date();
    const notes = session.metadata.notes || '';

    const bookingId = Date.now(); // Or UUID

    const booking = {
      id: bookingId,
      customername: session.metadata.name || 'Unknown',
      customeremail: session.metadata.email || '',
      customerphone: session.metadata.phone || '',
      pickup: session.metadata.pickup || '',
      dropoff: session.metadata.dropoff || '',
      pickuptime: datetime.toISOString(),
      vehicletype: session.metadata.vehicleType || '',
      fare: totalFare,
      distance_km: distanceKm,
      duration_min: durationMin,
      notes: notes,
      status: 'pending',
      createdat: new Date().toISOString(),
      assignedto: null,
      assignedat: null
    };

    try {
      const { data, error } = await supabase.from('pending_jobs').insert([booking]);
      if (error) console.error('❌ Supabase insert error (pending_jobs):', error);
      else console.log('✅ Booking saved to pending_jobs:', data);

      // Send admin email
      await sendEmail(booking);
      await sendInvoicePDF(booking, session.id);
    } catch (err) {
      console.error('Unexpected insert error:', err);
    }
  }

  res.status(200).json({ received: true });
});

/* ------------------- EMAIL & PDF FUNCTIONS ------------------- */
async function sendEmail(booking) {
  try {
    await transporter.sendMail({
      from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO,
      subject: `New Booking from ${booking.customername}`,
      html: `
        <h2>New Chauffeur Booking</h2>
        <p><strong>Name:</strong> ${booking.customername}</p>
        <p><strong>Email:</strong> ${booking.customeremail}</p>
        <p><strong>Phone:</strong> ${booking.customerphone}</p>
        <p><strong>Pickup:</strong> ${booking.pickup}</p>
        <p><strong>Dropoff:</strong> ${booking.dropoff}</p>
        <p><strong>Pickup Time:</strong> ${booking.pickuptime}</p>
        <p><strong>Vehicle Type:</strong> ${booking.vehicletype}</p>
        <p><strong>Total Fare:</strong> $${booking.fare}</p>
        <p><strong>Distance:</strong> ${booking.distance_km} km</p>
        <p><strong>Estimated Time:</strong> ${booking.duration_min} min</p>
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
      .text('ABN: ______________________')
      .moveDown()
      .text(`Invoice Number: ${sessionId}`)
      .text(`Date: ${new Date().toLocaleDateString()}`)
      .moveDown()
      .text('Billed To:')
      .text(`Name: ${booking.customername}`)
      .text(`Email: ${booking.customeremail}`)
      .text(`Phone: ${booking.customerphone}`)
      .moveDown()
      .text(`Pickup: ${booking.pickup}`)
      .text(`Dropoff: ${booking.dropoff}`)
      .text(`Pickup Time: ${booking.pickuptime}`)
      .text(`Vehicle Type: ${booking.vehicletype}`)
      .moveDown()
      .text(`Distance: ${booking.distance_km} km`)
      .text(`Estimated Duration: ${booking.duration_min} min`)
      .text(`Notes: ${booking.notes || 'None'}`)
      .moveDown()
      .fontSize(14).text(`Total Fare: $${booking.fare}`, { align: 'right' });

    doc.end();

    bufferStream.on('finish', async () => {
      const pdfBuffer = bufferStream.getContents();
      await transporter.sendMail({
        from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
        to: booking.customeremail,
        subject: 'Your Chauffeur de Luxe Invoice',
        text: 'Please find your invoice attached.',
        attachments: [{ filename: 'invoice.pdf', content: pdfBuffer, contentType: 'application/pdf' }]
      });
    });
  } catch (err) {
    console.error('Invoice PDF error:', err);
  }
}

/* ------------------- ASSIGN JOB ------------------- */
app.post('/assign-job', async (req, res) => {
  try {
    const { bookingData } = req.body;
    const { id, assignedto } = bookingData;

    if (!id || !assignedto) return res.status(400).json({ error: 'Missing driver or booking id' });

    const driverPay = bookingData.fare ? bookingData.fare * 0.8 : 0;

    const { error: insertError } = await supabase
      .from('completed_jobs')
      .insert([{
        id,
        bookingData,
        driverEmail: assignedto,
        driverPay,
        assignedAt: new Date().toISOString(),
        completedAt: null
      }]);

    if (insertError) return res.status(500).json({ error: 'Error assigning job' });

    const { error: deleteError } = await supabase
      .from('pending_jobs')
      .delete()
      .eq('id', id);

    if (deleteError) return res.status(500).json({ error: 'Error deleting from pending jobs' });

    await transporter.sendMail({
      from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
      to: assignedto,
      subject: `New Chauffeur Job Assigned`,
      html: `
        <h2>You have a new job assigned</h2>
        <p><strong>Name:</strong> ${bookingData.customername}</p>
        <p><strong>Pickup:</strong> ${bookingData.pickup}</p>
        <p><strong>Dropoff:</strong> ${bookingData.dropoff}</p>
        <p><strong>Pickup Time:</strong> ${bookingData.pickuptime}</p>
        <p><strong>Vehicle Type:</strong> ${bookingData.vehicletype}</p>
        <p><strong>Driver Payout:</strong> $${driverPay}</p>
      `
    });

    res.json({ message: 'Job assigned successfully' });
  } catch (err) {
    console.error('Assign job error:', err);
    res.status(500).json({ error: 'Server error in /assign-job' });
  }
});

/* ------------------- PENDING JOBS FETCH ------------------- */
app.get('/pending-jobs', async (req, res) => {
  try {
    const { data: pending, error } = await supabase
      .from('pending_jobs')
      .select('*')
      .eq('status', 'pending')
      .order('createdat', { ascending: true });

    if (error) throw error;
    res.json(pending || []);
  } catch (err) {
    console.error('Pending jobs error:', err);
    res.status(500).json({ error: 'Server error fetching pending jobs' });
  }
});

/* ------------------- COMPLETED JOBS ------------------- */
app.get('/completed-jobs', async (req, res) => {
  try {
    const { data, error } = await supabase.from('completed_jobs').select('*');
    if (error) throw error;

    const formatted = data.map(job => ({
      id: job.id,
      driverEmail: job.driverEmail || '',
      bookingData: job.bookingData || {},
      driverPay: job.driverPay || 0,
      assignedAt: job.assignedAt,
      completedAt: job.completedAt
    }));

    res.json(formatted);
  } catch (err) {
    console.error('Completed jobs error:', err);
    res.status(500).json({ error: 'Server error fetching completed jobs' });
  }
});

/* ------------------- ADMIN PANEL: DRIVERS ------------------- */
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
  drivers = drivers.filter(d => d.email.toLowerCase() !== email);
  fs.writeFileSync(dataPath, JSON.stringify(drivers, null, 2));
  res.json({ message: `Driver with email ${email} deleted` });
});

/* ------------------- ADMIN PANEL: JOBS ------------------- */
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
  jobs = jobs.filter(j => j.id !== jobId);
  fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
  res.json({ message: `Job with ID ${jobId} deleted` });
});

/* ------------------- DRIVER LOGIN ------------------- */
app.post('/driver-login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const { data: assignedJobs, error: assignedError } = await supabase
      .from('pending_jobs')
      .select('*')
      .eq('assignedto', email)
      .order('pickuptime', { ascending: true });

    if (assignedError) throw assignedError;

    const { data: completedJobs, error: completedError } = await supabase
      .from('completed_jobs')
      .select('*')
      .ilike('driverEmail', email)
      .order('completedAt', { ascending: false });

    if (completedError) throw completedError;

    res.json({ jobs: assignedJobs || [], completed: completedJobs || [] });
  } catch (err) {
    console.error('Driver login error:', err);
    res.status(500).json({ error: 'Failed to fetch driver jobs' });
  }
});

/* ------------------- DRIVER RESPONSE ------------------- */
app.post('/driver-response', (req, res) => {
  const { driverEmail, jobId, confirmed } = req.body;
  if (!driverEmail || !jobId || typeof confirmed !== 'boolean') 
    return res.status(400).json({ error: 'Missing required fields or invalid data' });

  const jobsFile = path.join(__dirname, 'driver-jobs.json');
  if (!fs.existsSync(jobsFile)) return res.status(404).json({ error: 'Jobs file not found' });

  let jobs = JSON.parse(fs.readFileSync(jobsFile));
  const jobIndex = jobs.findIndex(j => j.id === jobId && j.driverEmail.toLowerCase() === driverEmail.toLowerCase());
  if (jobIndex === -1) return res.status(404).json({ error: 'Job not found for this driver' });

  const jobData = jobs[jobIndex];

  if (confirmed) {
    jobs[jobIndex].driverConfirmed = true;
    jobs[jobIndex].responseAt = new Date();
  } else {
    jobs.splice(jobIndex, 1);
  }

  fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));

  transporter.sendMail({
    from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
    to: process.env.EMAIL_TO,
    subject: `Driver Job Response - ${confirmed ? 'CONFIRMED' : 'REFUSED'} - ${jobId}`,
    html: `
      <p>Driver <strong>${driverEmail}</strong> has <strong>${confirmed ? 'CONFIRMED ✅' : 'REFUSED ❌'}</strong> the job.</p>
      <p><strong>Name:</strong> ${jobData.bookingData.name}</p>
      <p><strong>Pickup:</strong> ${jobData.bookingData.pickup}</p>
      <p><strong>Dropoff:</strong> ${jobData.bookingData.dropoff}</p>
      <p><strong>Pickup Time:</strong> ${jobData.bookingData.datetime}</p>
      <p><strong>Vehicle Type:</strong> ${jobData.bookingData.vehicleType}</p>
      <p><strong>Driver Payout:</strong> $${jobData.driverPay.toFixed(2)}</p>
      <p><strong>Notes:</strong> ${jobData.bookingData.notes || 'None'}</p>
    `
  }).catch(console.error);

  res.json({ message: 'Driver response recorded successfully' });
});

/* ------------------- DRIVER COMPLETE ------------------- */
app.post('/driver-complete', async (req, res) => {
  const { driverEmail, jobId } = req.body;
  if (!driverEmail || !jobId)
    return res.status(400).json({ error: 'Missing required fields' });

  const jobsFile = path.join(__dirname, 'driver-jobs.json');
  if (!fs.existsSync(jobsFile))
    return res.status(404).json({ error: 'Jobs file not found' });

  let jobs = JSON.parse(fs.readFileSync(jobsFile));
  const jobIndex = jobs.findIndex(
    j => j.id === jobId && j.driverEmail.toLowerCase() === driverEmail.toLowerCase()
  );

  if (jobIndex === -1) return res.status(404).json({ error: 'Job not found for this driver' });

  const jobData = jobs[jobIndex];
  jobData.completed = true;
  jobData.completedAt = new Date();

  const jobToInsert = {
    id: jobData.id,
    driverEmail: jobData.driverEmail,
    bookingData: JSON.parse(JSON.stringify(jobData.bookingData)),
    driverPay: jobData.driverPay,
    assignedAt: jobData.assignedAt ? new Date(jobData.assignedAt).toISOString() : null,
    completedAt: jobData.completedAt.toISOString()
  };

  try {
    const { error } = await supabase
      .from('completed_jobs')
      .upsert([jobToInsert], { onConflict: ['id'] });

    if (error) return res.status(500).json({ error: 'Failed to save completed job' });

    jobs.splice(jobIndex, 1);
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));

    await transporter.sendMail({
      from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO,
      subject: `Driver Job Completed - ${jobId}`,
      html: `
        <p>Driver <strong>${driverEmail}</strong> has <strong>COMPLETED ✅</strong> the job <strong>${jobId}</strong>.</p>
        <p><strong>Name:</strong> ${jobData.bookingData.name}</p>
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
    console.error('Unexpected error completing job:', err);
    res.status(500).json({ error: 'Server error completing job' });
  }
});

/* ------------------- DRIVER HISTORY ------------------- */
app.post('/driver-history', async (req, res) => {
  const { driverEmail } = req.body;
  if (!driverEmail) return res.status(400).json({ error: 'Email required' });

  try {
    const { data, error } = await supabase
      .from('completed_jobs')
      .select('*')
      .ilike('driverEmail', driverEmail)
      .order('completedAt', { ascending: false });

    if (error) return res.status(500).json({ error: 'Failed to fetch driver history' });

    res.json(data || []);
  } catch (err) {
    console.error('Driver history error:', err);
    res.status(500).json({ error: 'Server error fetching driver history' });
  }
});

/* ------------------- RENEWAL REMINDERS (CRON) ------------------- */
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
          }).catch(console.error);
                  }
      });
  });
});

/* ------------------- START SERVER ------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
