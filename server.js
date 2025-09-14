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
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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

    // Parse metadata safely
    const totalFare = parseFloat(s.metadata.totalFare) || 0;
    const distanceKm = parseFloat(s.metadata.distanceKm) || 0;
    const durationMin = parseFloat(s.metadata.durationMin) || 0;
    const datetime = s.metadata.datetime ? new Date(s.metadata.datetime) : new Date();

    const bookingId = Date.now(); // Or use UUID if you prefer
    const booking = {
   id: bookingId,
  customername: s.metadata.name || 'Unknown',
  customeremail: s.metadata.email || '',
  customerphone: s.metadata.phone || '',
  pickup: s.metadata.pickup || '',
  dropoff: s.metadata.dropoff || '',
  pickuptime: datetime.toISOString(),
  vehicletype: s.metadata.vehicleType || '',
  fare: totalFare,
  status: 'pending',
  createdat: new Date().toISOString(),
  assignedto: null,
  assignedat: null,
  distance_km: distanceKm,    // JS variable maps to lowercase DB column
  duration_min: durationMin,  // JS variable maps to lowercase DB column
  notes: notes
};

    try {
      // Insert directly into the 'bookings' table your admin page reads
      const { data, error } = await supabase.from('pending_jobs').insert([booking]);

      if (error) {
  console.error('❌ Supabase insert error (pending_jobs):', error);
} else {
  console.log('✅ Booking saved to pending_jobs table:', data);
}

      // Optional: send email and PDF invoice
      sendEmail(booking).catch(console.error);
      sendInvoicePDF(booking, s.id).catch(console.error);

    } catch (err) {
      console.error('Unexpected insert error:', err);
    }
  }

  // Respond to Stripe
  res.status(200).json({ received: true });
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
  // accept both notes and hourlyNotes
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

  // merge them: if hourlyNotes exists, use it, otherwise fall back to notes
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
        notes: finalNotes,  // ✅ always include notes
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

app.post('/assign-job', async (req, res) => {
  const { driverEmail, bookingId } = req.body;

  if (!driverEmail || !bookingId)
    return res.status(400).json({ error: 'Missing driverEmail or bookingId' });

  try {
    // Fetch the job from pending_jobs
    const { data: jobData, error: fetchError } = await supabase
      .from('pending_jobs')
      .select('*')
      .eq('id', bookingId)
      .single();

    if (fetchError || !jobData) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (jobData.status === 'assigned') {
      return res.status(400).json({ error: 'Job already assigned' });
    }

    // Calculate driver pay (optional)
    const driverPay = jobData.fare ? parseFloat((jobData.fare / 1.45).toFixed(2)) : 0;

    // Update pending_jobs: assign to driver
    const { error: updateError } = await supabase
      .from('pending_jobs')
      .update({
        assignedto: driverEmail,
        assignedat: new Date().toISOString(),
        status: 'assigned',
        driverpay: driverPay
      })
      .eq('id', bookingId);

    if (updateError) {
      return res.status(500).json({ error: 'Failed to assign job' });
    }

    // Send email notification to driver
    await transporter.sendMail({
      from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
      to: driverEmail,
      subject: `New Chauffeur Job Assigned`,
      html: `
        <h2>You have a new job assigned</h2>
        <p><strong>Name:</strong> ${jobData.customername}</p>
        <p><strong>Email:</strong> ${jobData.customeremail}</p>
        <p><strong>Phone:</strong> ${jobData.customerphone}</p>
        <p><strong>Pickup:</strong> ${jobData.pickup}</p>
        <p><strong>Dropoff:</strong> ${jobData.dropoff}</p>
        <p><strong>Pickup Time:</strong> ${jobData.pickuptime}</p>
        <p><strong>Vehicle Type:</strong> ${jobData.vehicletype}</p>
        <p><strong>Driver Payout:</strong> $${driverPay}</p>
        <p>Please login to your driver dashboard to view full details.</p>
      `
    });

    res.json({ message: 'Job assigned successfully', jobId: bookingId });

  } catch (err) {
    console.error('Assign job error:', err);
    res.status(500).json({ error: 'Server error assigning job' });
  }
});

/* ------------------- PENDING JOBS FETCH (Supabase) ------------------- */
app.get('/pending-jobs', async (req, res) => {
  try {
    // Fetch only jobs with status = 'pending'
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

// ------------------- COMPLETED JOBS ROUTE -------------------
app.get('/completed-jobs', async (req, res) => {
  try {
    const { data, error } = await supabase.from('completed_jobs').select('*');
    if (error) {
      console.error('Error fetching completed jobs:', error);
      return res.status(500).json({ error: 'Failed to fetch completed jobs' });
    }

    // Ensure the structure matches admin HTML expectations
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

/* ------------------- ADMIN PANEL ------------------- */
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

/* ------------------- DRIVER LOGIN (Supabase) ------------------- */
app.post('/driver-login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    // Fetch assigned jobs from pending_jobs table
    const { data: assignedJobs, error: assignedError } = await supabase
      .from('pending_jobs')
      .select('*')
      .eq('assignedto', email)
      .order('pickuptime', { ascending: true });

    if (assignedError) throw assignedError;

    // Fetch completed jobs
    const { data: completedJobs, error: completedError } = await supabase
      .from('completed_jobs')
      .select('*')
      .ilike('driverEmail', email)
      .order('completedAt', { ascending: false });

    if (completedError) throw completedError;

    res.json({
      jobs: assignedJobs || [],
      completed: completedJobs || []
    });
  } catch (err) {
    console.error('Driver login error:', err);
    res.status(500).json({ error: 'Failed to fetch driver jobs' });
  }
});

/* ------------------- RENEWAL REMINDERS ------------------- */
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

  const jobData = jobs[jobIndex]; // Save job data for email

  if (confirmed) {
    // CONFIRMED: keep job on driver screen and mark as confirmed
    jobs[jobIndex].driverConfirmed = true;
    jobs[jobIndex].responseAt = new Date();
  } else {
    // REFUSED: remove job from driver-jobs.json so it can be reassigned
    jobs.splice(jobIndex, 1);
  }

  fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));

  // Send admin email
  transporter.sendMail({
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
  }).catch(console.error);

  res.json({ message: 'Driver response recorded successfully' });
});

/* ------------------- DRIVER COMPLETE (FIXED) ------------------- */
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

  // ------------------- PREPARE SAFE INSERT -------------------
  const jobToInsert = {
    id: jobData.id,
    driverEmail: jobData.driverEmail,
    bookingData: JSON.parse(JSON.stringify(jobData.bookingData)), // serialize safely
    driverPay: jobData.driverPay,
    assignedAt: jobData.assignedAt ? new Date(jobData.assignedAt).toISOString() : null,
    completedAt: jobData.completedAt.toISOString()
  };

  console.log('Job to insert:', JSON.stringify(jobToInsert, null, 2));

  try {
    // Use upsert to avoid duplicate primary key errors
    const { error } = await supabase
      .from('completed_jobs')
      .upsert([jobToInsert], { onConflict: ['id'] });

    if (error) {
      console.error('Supabase insert/upsert error:', error);
      return res.status(500).json({ error: 'Failed to save completed job in Supabase' });
    }

    console.log(`✅ Job ${jobId} saved to completed_jobs successfully.`);

    // Remove from active jobs after successful insert
    jobs.splice(jobIndex, 1);
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
    console.log(`✅ Job ${jobId} removed from driver-jobs.json`);

    // Send admin email
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
    console.error('Unexpected error completing job:', err);
    res.status(500).json({ error: 'Server error completing job' });
  }
});


/* ------------------- DRIVER HISTORY ------------------- */
app.post('/driver-history', async (req, res) => {
  const { driverEmail } = req.body;
  if (!driverEmail) return res.status(400).json({ error: 'Email required' });

  try {
    // Use ilike to allow case-insensitive match if driverEmail casing differs
    const { data, error } = await supabase
      .from('completed_jobs')
      .select('*')
      .ilike('driverEmail', driverEmail)
      .order('completedAt', { ascending: false });

    if (error) {
      console.error('Error fetching driver history:', error);
      return res.status(500).json({ error: 'Failed to fetch driver history' });
    }

    res.json(data || []);
  } catch (err) {
    console.error('Driver history error:', err);
    res.status(500).json({ error: 'Server error fetching driver history' });
  }
});

/* ------------------- START SERVER ------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
