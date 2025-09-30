console.log("DEBUG: SUPABASE_URL =", `"${process.env.SUPABASE_URL}"`);
console.log("DEBUG: SUPABASE_SERVICE_ROLE_KEY =", `"${process.env.SUPABASE_SERVICE_ROLE_KEY}"`);
console.log("DEBUG: STRIPE_SECRET_KEY =", `"${process.env.STRIPE_SECRET_KEY ? '[FOUND]' : '[NOT FOUND]'}"`);
console.log("DEBUG: SENDGRID_API_KEY starts with", process.env.SENDGRID_API_KEY?.slice(0,4));
console.log("DEBUG: EMAIL_USER =", `"${process.env.EMAIL_USER}"`);
console.log("DEBUG: EMAIL_TO =", `"${process.env.EMAIL_TO}"`);
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
const bcrypt = require('bcryptjs');
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
app.use(cors({
  origin: [
    'https://bookingform-pi.vercel.app',         // old domain
    'https://bookings.chauffeurdeluxe.com.au'   // new domain
  ]
}));
app.use(express.static('public'));

/* ------------------- STRIPE WEBHOOK ------------------- */
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("✅ Webhook received:", event.type);

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    console.log("🔔 Checkout session:", s);

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
      distanceKm: parseFloat(s.metadata.distanceKm) || 0,
      durationMin: parseFloat(s.metadata.durationMin) || 0,
      notes: s.metadata.notes || ''
    };

    try {
      const { error } = await supabase.from('pending_jobs').insert([{
        id: booking.id,
        customername: booking.name,
        customeremail: booking.email,
        customerphone: booking.phone,
        pickup: booking.pickup,
        dropoff: booking.dropoff,
        pickuptime: booking.datetime,
        vehicletype: booking.vehicleType,
        fare: booking.totalFare,
        status: 'pending',
        createdat: new Date(),
        distance_km: booking.distanceKm,
        duration_min: booking.durationMin,
        notes: booking.notes,
        assignedto: null
      }]);

      if (error) {
        console.error("❌ Supabase insert error:", error.message);
      } else {
        console.log("✅ Booking inserted into Supabase:", booking.id);
      }
    } catch (err) {
      console.error("❌ Exception inserting booking:", err);
    }

    // Send email + invoice as before
    try { await sendEmail(booking); console.log("✅ Notification email sent"); } 
    catch (err) { console.error("❌ Email error:", err); }

    try { await sendInvoicePDF(booking, s.id); console.log("✅ Invoice sent"); } 
    catch (err) { console.error("❌ Invoice error:", err); }
  }

  res.json({ received: true });
});

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

/* ------------------- HELPER: DRIVER PAY ------------------- */
function calculateDriverPayout(clientFare) {
  const net = clientFare / 1.45;
  return parseFloat(net.toFixed(2));
}

/* ------------------- PARTNER FORM ROUTE ------------------- */
app.post('/partner-form', upload.fields([
  { name: 'insuranceFile', maxCount: 1 },
  { name: 'regoFile', maxCount: 1 },
  { name: 'licenceFile', maxCount: 1 }
]), async (req, res) => {
  try {
    const data = req.body;
    const files = req.files;

    const attachments = [];
    for (let field in files) {
      attachments.push({ filename: files[field][0].originalname, path: files[field][0].path });
    }

   await sgMail.send({
  to: process.env.EMAIL_TO,
  from: process.env.EMAIL_USER,
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
  attachments: Object.values(req.files).flat().map(f => ({
    filename: f.originalname,
    path: f.path
  }))
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

  if (!email || !totalFare || totalFare < 10) {
    return res.status(400).json({ error: 'Invalid booking data.' });
  }

  try {
    const finalNotes = hourlyNotes || notes || '';

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
        name, email, phone, pickup, dropoff, datetime,
        vehicleType, totalFare: totalFare.toString(),
        notes: finalNotes,
        distanceKm: distanceKm ? distanceKm.toString() : 'N/A',
        durationMin: durationMin ? durationMin.toString() : 'N/A'
      },
      success_url: 'https://bookings.chauffeurdeluxe.com.au/success.html',
      cancel_url: 'https://bookings.chauffeurdeluxe.com.au/cancel.html'
    });

    res.status(200).json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Stripe session creation error:', err);
    res.status(500).json({ error: 'Stripe session creation failed.' });
  }
});

/* ------------------- SEND EMAIL (ADMIN NOTIFICATION) ------------------- */
async function sendEmail(booking) {
  const msg = {
    to: process.env.EMAIL_TO,             // Admin email
    from: process.env.EMAIL_USER,         // Verified SendGrid sender
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

  try {
    await sgMail.send(msg);
    console.log('✅ Admin notification sent via SendGrid API');
  } catch (err) {
    console.error('❌ Admin email error (SendGrid API):', err);
  }
}


async function sendInvoicePDF(booking, sessionId) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const bufferStream = new streamBuffers.WritableStreamBuffer();
      doc.pipe(bufferStream);

      // HEADER: Black background, logo, gold text
      doc.rect(0, 0, doc.page.width, 100).fill('#000000');
      // Logo
      doc.image('./icon.png', 50, 20, { width: 80 });
      // Company name & tagline
      doc.fillColor('#B9975B').fontSize(24).text('CHAUFFEUR DE LUXE', 150, 25);
      doc.fontSize(12).text('Driven by Distinction. Defined by Elegance.', 150, 55);

      doc.moveDown(5);

      // INVOICE TITLE
      doc.fillColor('black').fontSize(20).text('Invoice', { align: 'center' });
      doc.moveDown();

      // Invoice metadata
      doc.fontSize(12)
         .text(`Invoice Number: ${sessionId}`, { continued: true })
         .text(`   Date: ${new Date().toLocaleDateString()}`, { align: 'right' });
      doc.moveDown();

      // CUSTOMER DETAILS
      doc.fontSize(12).text('Billed To:', { underline: true });
      doc.text(`Name: ${booking.name}`);
      doc.text(`Email: ${booking.email}`);
      doc.text(`Phone: ${booking.phone}`);
      doc.moveDown();

      // BOOKING DETAILS TABLE
      const tableTop = doc.y;
      const rowHeight = 25;

      // Table headers with gold background
      doc.rect(50, tableTop, 500, rowHeight).fill('#B9975B');
      doc.fillColor('black').fontSize(12).text('Pickup', 55, tableTop + 7);
      doc.text('Dropoff', 155, tableTop + 7);
      doc.text('Date/Time', 305, tableTop + 7);
      doc.text('Vehicle', 425, tableTop + 7);
      doc.text('Distance', 505, tableTop + 7);
      doc.text('Fare', 555, tableTop + 7);

      // Table data row
      const dataY = tableTop + rowHeight;
      doc.rect(50, dataY, 500, rowHeight).stroke('#B9975B'); // gold border
      doc.fillColor('black')
         .text(booking.pickup, 55, dataY + 7)
         .text(booking.dropoff, 155, dataY + 7)
         .text(booking.datetime, 305, dataY + 7)
         .text(booking.vehicleType, 425, dataY + 7)
         .text(`${booking.distanceKm} km`, 505, dataY + 7)
         .text(`$${booking.totalFare}`, 555, dataY + 7);

      doc.moveDown(4);

      // TOTAL FARE HIGHLIGHT
      doc.rect(400, doc.y, 150, 30).fill('#B9975B');
      doc.fillColor('#000000').fontSize(14).text(`Total: $${booking.totalFare}`, 410, doc.y + 7);

      // FOOTER
      doc.moveDown(4);
      doc.fontSize(10).fillColor('gray')
         .text('Chauffeur de Luxe – Premium Chauffeur Service', { align: 'center' })
         .text('www.chauffeurdeluxe.com.au | info@chauffeurdeluxe.com.au | +61 402 256 915', { align: 'center' });

      doc.end();

      bufferStream.on('finish', async () => {
        const pdfBuffer = bufferStream.getContents();
        if (!pdfBuffer) return reject(new Error('PDF generation failed'));

        try {
          await sgMail.send({
            to: booking.email,
            from: process.env.EMAIL_USER,
            subject: 'Your Chauffeur de Luxe Invoice',
            text: 'Please find your invoice attached.',
            attachments: [
              {
                content: pdfBuffer.toString('base64'),
                filename: 'invoice.pdf',
                type: 'application/pdf',
                disposition: 'attachment'
              }
            ]
          });
          console.log('✅ Styled invoice sent to customer via SendGrid API');
          resolve();
        } catch (err) {
          console.error('❌ Sending invoice email failed:', err);
          reject(err);
        }
      });
    } catch (err) {
      console.error('❌ PDF creation error:', err);
      reject(err);
    }
  });
}

/* ------------------- DRIVER SET PASSWORD ------------------- */
app.post('/driver-set-password', async (req, res) => {
  try {
    let { email, newPassword } = req.body;
    if (!email || !newPassword) return res.status(400).json({ error: 'Email and password required' });

    email = email.trim().toLowerCase();

    const { data: driver, error: selectError } = await supabase
      .from('drivers')
      .select('*')
      .eq('email', email)
      .single();

    if (selectError || !driver) return res.status(404).json({ error: 'Email not found' });

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const { error: updateError } = await supabase
      .from('drivers')
      .update({ passwordhash: hashedPassword })
      .eq('email', email);

    if (updateError) return res.status(500).json({ error: 'Failed to set password' });

    res.json({ success: true, message: 'Password set successfully' });
  } catch (err) {
    console.error('Driver set password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------- CHECK DRIVER ------------------- */
app.post('/check-driver', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const { data: driver, error } = await supabase
      .from('drivers')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !driver) return res.json({ needsPassword: false });

    return res.json({ needsPassword: !driver.passwordhash });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------- DRIVER LOGIN ------------------- */
app.post('/driver-login', async (req, res) => {
  try {
    let { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    email = email.trim().toLowerCase();

    const { data: driver, error } = await supabase
      .from('drivers')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !driver) return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, driver.passwordhash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    await supabase.from('drivers').update({ lastlogin: new Date() }).eq('id', driver.id);

    res.json({ success: true, driver: { id: driver.id, name: driver.name, email: driver.email } });
  } catch (err) {
    console.error('Driver login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET driver jobs with driver payout and customer info
app.get('/driver-jobs', async (req, res) => {
  try {
    const email = req.query.email?.trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Driver email is required' });

    console.log('Driver email requested:', email); // debug

    // Assigned jobs from pending_jobs (driverPay calculated on assignment)
    const { data: assignedJobs, error: assignedError } = await supabase
      .from('pending_jobs')
      .select('*')
      .eq('assignedto', email)
      .eq('status', 'assigned')
      .order('pickuptime', { ascending: true });

    if (assignedError) {
      console.error('Error fetching assigned jobs:', assignedError);
      return res.status(500).json({ error: 'Failed to fetch assigned jobs' });
    }

    // Completed jobs from completed_jobs (driverPay read from DB)
    const { data: completedJobs, error: completedError } = await supabase
      .from('completed_jobs')
      .select('*')
      .eq('driverEmail', email)
      .order('completedAt', { ascending: false });

    if (completedError) {
      console.error('Error fetching completed jobs:', completedError);
      return res.status(500).json({ error: 'Failed to fetch completed jobs' });
    }

    // Map assigned jobs with driverPay calculated for preview (optional)
    const assignedWithPayout = (assignedJobs || []).map(job => ({
      id: job.id,
      pickup: job.pickup,
      dropoff: job.dropoff,
      pickuptime: job.pickuptime,
      vehicletype: job.vehicletype,
      driverPay: calculateDriverPayout(job.fare), // optional for assigned jobs
      notes: job.notes,
      distance_km: job.distance_km,
      duration_min: job.duration_min,
      status: job.status,
      customername: job.customername,
      customerphone: job.customerphone
    }));

    // Map completed jobs using stored driverPay
    const completedWithPayout = (completedJobs || []).map(job => ({
      id: job.id,
      pickup: job.pickup,
      dropoff: job.dropoff,
      pickuptime: job.pickuptime,
      vehicletype: job.vehicletype,
      driverPay: job.driverPay,  // use stored value
      notes: job.notes,
      distance_km: job.distance_km,
      duration_min: job.duration_min,
      status: job.status,
      customername: job.customername,
      customerphone: job.customerphone,
      completedAt: job.completedAt
    }));

    res.json({ assignedJobs: assignedWithPayout, completedJobs: completedWithPayout });
  } catch (err) {
    console.error('Driver jobs error:', err);
    res.status(500).json({ error: 'Server error fetching jobs' });
  }
});

// ------------------- UPDATE JOB -------------------
app.post('/update-job', async (req, res) => {
  try {
    const { jobId, status, driverEmail } = req.body;
    if (!jobId || !status || !driverEmail) {
      return res.status(400).json({ error: 'Missing parameters' });
    }

    const email = driverEmail.trim().toLowerCase();

    // Fetch the job from pending_jobs
    const { data: jobData, error: fetchError } = await supabase
      .from('pending_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (fetchError || !jobData) return res.status(404).json({ error: 'Job not found' });

    if (status === 'confirmed') {
      // Confirm job without changing assignment
      const { error: confirmError } = await supabase
        .from('pending_jobs')
        .update({ status: 'confirmed', assignedto: email })
        .eq('id', jobId);
      if (confirmError) throw confirmError;

      return res.json({ success: true });
    }

    if (status === 'completed') {
      // Move job to completed_jobs with driverPay
      const driverPay = calculateDriverPayout(jobData.fare);

      const { data: insertedJob, error: insertError } = await supabase
        .from('completed_jobs')
        .insert([{
          ...jobData,
          driverEmail: email,
          driverPay,
          completedAt: new Date().toISOString(),
          status: 'completed'
        }])
        .select()
        .single();

      if (insertError) throw insertError;

      // Delete from pending_jobs after successful insert
      const { error: deleteError } = await supabase
        .from('pending_jobs')
        .delete()
        .eq('id', jobId);
      if (deleteError) throw deleteError;

      return res.json({ success: true, completedJobId: insertedJob.id });
    }

    if (status === 'refused') {
      // Reset job to pending if refused
      const { error: refuseError } = await supabase
        .from('pending_jobs')
        .update({ status: 'pending', assignedto: null })
        .eq('id', jobId);
      if (refuseError) throw refuseError;

      return res.json({ success: true });
    }

    res.status(400).json({ error: 'Invalid status' });

  } catch (err) {
    console.error('Update job error:', err);
    res.status(500).json({ error: 'Failed to update job' });
  }
});

// ------------------- GET PENDING BOOKINGS FOR ADMIN -------------------
app.get('/pending-bookings', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pending_jobs')
      .select('*')
      .eq('status', 'pending')       // <-- only truly pending
      .order('createdat', { ascending: true });

    if (error) return res.status(500).json({ error: 'Failed to fetch pending bookings' });

    res.json(data);
  } catch (err) {
    console.error('Fetch pending bookings error:', err);
    res.status(500).json({ error: 'Server error fetching pending bookings' });
  }
});

/* ------------------- ASSIGN JOB ------------------- */
app.post('/assign-job', async (req, res) => {
  try {
    const { driverEmail, bookingId } = req.body;

    if (!driverEmail || !bookingId) {
      return res.status(400).json({ error: 'Missing driverEmail or bookingId' });
    }

    // 1. Check booking exists in pending_jobs
    const { data: booking, error: bookingError } = await supabase
      .from('pending_jobs')
      .select('*')
      .eq('id', bookingId)
      .single();

    if (bookingError || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // 2. Update booking → mark as assigned
    const { error: updateError } = await supabase
      .from('pending_jobs')
      .update({
        assignedto: driverEmail.trim().toLowerCase(),
        status: 'assigned',
        assignedat: new Date()
      })
      .eq('id', bookingId);

    if (updateError) {
      console.error('Error assigning booking:', updateError);
      return res.status(500).json({ error: 'Failed to assign job' });
    }

    // 3. Calculate driver pay
    const driverPay = calculateDriverPayout(booking.fare);

    // 4. Send email to driver using SendGrid
    const msg = {
      to: driverEmail.trim().toLowerCase(),
      from: process.env.EMAIL_USER,  // must be verified in SendGrid
      subject: '🚘 New Job Assigned',
      text: `
Hello,

You have been assigned a new job:

Pickup: ${booking.pickup}
Dropoff: ${booking.dropoff}
Date & Time: ${new Date(booking.pickuptime).toLocaleString()}
Customer: ${booking.customername}
Customer Phone: ${booking.customerphone}
Your Pay: $${driverPay}

Please log in to your driver portal to confirm.
      `
    };

    try {
      await sgMail.send(msg);
      console.log(`✅ Job assignment email sent to ${driverEmail}`);
    } catch (err) {
      console.error('❌ Assign job email error:', err);
    }

    res.json({ success: true, message: `Job assigned to ${driverEmail}` });

  } catch (err) {
    console.error('Assign job error:', err);
    res.status(500).json({ error: 'Server error assigning job' });
  }
});

// ------------------- COMPLETE JOB (standalone) -------------------
app.post('/complete-job', async (req, res) => {
  try {
    const { jobId, driverEmail } = req.body;
    if (!jobId || !driverEmail) return res.status(400).json({ error: 'Missing jobId or driverEmail' });

    const email = driverEmail.trim().toLowerCase();

    // Fetch job from pending_jobs
    const { data: job, error: jobError } = await supabase
      .from('pending_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobError || !job) return res.status(404).json({ error: 'Job not found' });

    // Calculate driverPay
    const driverPay = calculateDriverPayout(job.fare);

    // Insert into completed_jobs
    const { data: insertedJob, error: insertError } = await supabase
      .from('completed_jobs')
      .insert([{
        ...job,
        driverEmail: email,
        driverPay,
        completedAt: new Date().toISOString(),
        status: 'completed'
      }])
      .select()
      .single();

    if (insertError) throw insertError;

    // Delete from pending_jobs
    const { error: deleteError } = await supabase
      .from('pending_jobs')
      .delete()
      .eq('id', jobId);

    if (deleteError) {
      console.error('Completed job saved, but failed to remove from pending:', deleteError);
      return res.status(500).json({ error: 'Completed job saved, but failed to remove from pending' });
    }

    res.json({ success: true, message: 'Job completed', completedJobId: insertedJob.id });
  } catch (err) {
    console.error('Complete job error:', err);
    res.status(500).json({ error: 'Server error completing job' });
  }
});

/* ------------------- GET COMPLETED JOBS ------------------- */
app.get('/completed-jobs', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('completed_jobs')
      .select('*')
      .order('completedAt', { ascending: false });

    if (error) return res.status(500).json({ error: 'Failed to fetch completed jobs' });

    res.json(data);
  } catch (err) {
    console.error('Fetch completed jobs error:', err);
    res.status(500).json({ error: 'Server error fetching completed jobs' });
  }
});

// ------------------- REFUSE JOB -------------------
app.post('/refuse-job', async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!jobId) return res.status(400).json({ error: 'Missing jobId' });

    const { error } = await supabase
      .from('pending_jobs')
      .update({ status: 'pending', assignedto: null })
      .eq('id', jobId);

    if (error) throw error;

    res.json({ success: true, message: 'Job refused, back to pending' });
  } catch (err) {
    console.error('Refuse job error:', err);
    res.status(500).json({ error: 'Failed to refuse job' });
  }
});

/* ------------------- START SERVER ------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

module.exports = app;
