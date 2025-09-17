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
const bcrypt = require('bcryptjs');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
app.use(cors());
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

/* ------------------- NODEMAILER ------------------- */
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
      success_url: 'https://bookingform-pi.vercel.app/success.html',
      cancel_url: 'https://bookingform-pi.vercel.app/cancel.html'
    });

    res.status(200).json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Stripe session creation error:', err);
    res.status(500).json({ error: 'Stripe session creation failed.' });
  }
});

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

// GET driver jobs with driver payout
app.get('/driver-jobs', async (req, res) => {
  try {
    const email = req.query.email?.trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Driver email is required' });

    // Assigned jobs from pending_jobs
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

    // Completed jobs from completed_jobs
    const { data: completedJobs, error: completedError } = await supabase
      .from('completed_jobs')
      .select('*')
      .eq('driverEmail', email)
      .order('completedAt', { ascending: false });

    if (completedError) {
      console.error('Error fetching completed jobs:', completedError);
      return res.status(500).json({ error: 'Failed to fetch completed jobs' });
    }

    // Calculate driver payout for assigned and completed jobs
    const assignedWithPayout = (assignedJobs || []).map(job => ({
      ...job,
      driverPay: calculateDriverPayout(job.fare)
    }));

    const completedWithPayout = (completedJobs || []).map(job => ({
      ...job,
      driverPay: calculateDriverPayout(job.fare)
    }));

    res.json({ assignedJobs: assignedWithPayout, completedJobs: completedWithPayout });
  } catch (err) {
    console.error('Driver jobs error:', err);
    res.status(500).json({ error: 'Server error fetching jobs' });
  }
});

/* ------------------- UPDATE JOB STATUS ------------------- */
app.post('/update-job', async (req, res) => {
  try {
    const { jobId, status, driverEmail } = req.body;

    if (!jobId || !status || !driverEmail) {
      return res.status(400).json({ error: 'Missing jobId, status, or driverEmail' });
    }

    const emailLower = driverEmail.trim().toLowerCase();

    // Fetch the job from pending_jobs
    const { data: job, error: fetchError } = await supabase
      .from('pending_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (fetchError || !job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (status === 'confirmed') {
      // Just update status to confirmed, do NOT move anywhere
      const { error: updateError } = await supabase
        .from('pending_jobs')
        .update({ status })
        .eq('id', jobId);

      if (updateError) throw updateError;

      return res.json({ success: true, message: 'Job confirmed' });
    }

    if (status === 'refused') {
      // Move job back to pending / unassign
      const { error: updateError } = await supabase
        .from('pending_jobs')
        .update({ status: 'pending', assignedto: null })
        .eq('id', jobId);

      if (updateError) throw updateError;

      return res.json({ success: true, message: 'Job refused' });
    }

    if (status === 'completed') {
      // Move job to completed_jobs
      const completedData = {
        ...job,
        driverEmail: emailLower,
        completedAt: new Date(),
        status: 'completed'
      };

      // Remove fields that might conflict with completed_jobs schema
      delete completedData.id;
      delete completedData.assignedat;

      const { error: insertError } = await supabase
        .from('completed_jobs')
        .insert([completedData]);

      if (insertError) throw insertError;

      // Delete from pending_jobs
      const { error: deleteError } = await supabase
        .from('pending_jobs')
        .delete()
        .eq('id', jobId);

      if (deleteError) throw deleteError;

      return res.json({ success: true, message: 'Job completed' });
    }

    res.status(400).json({ error: 'Invalid status' });
  } catch (err) {
    console.error('Update job error:', err);
    res.status(500).json({ error: 'Server error updating job' });
  }
});

/* ------------------- GET PENDING BOOKINGS FOR ADMIN ------------------- */
app.get('/pending-bookings', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pending_jobs')
      .select('*')
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
    const { driverEmail, bookingData, bookingId } = req.body;

    const idToAssign = bookingId || (bookingData && bookingData.id);
    if (!driverEmail || !idToAssign) 
      return res.status(400).json({ error: 'Missing driverEmail or bookingId' });

    const { data: booking, error: bookingError } = await supabase
      .from('pending_jobs')
      .select('*')
      .eq('id', idToAssign)
      .single();

    if (bookingError || !booking) 
      return res.status(404).json({ error: 'Booking not found' });

    const { data: updatedBooking, error: updateError } = await supabase
      .from('pending_jobs')
      .update({
        assignedto: driverEmail.trim().toLowerCase(),
        status: 'assigned',
        assignedat: new Date()
      })
      .eq('id', idToAssign)
      .select()
      .single();

    if (updateError) {
      console.error('Error updating booking:', updateError);
      return res.status(500).json({ error: 'Failed to assign job' });
    }

    res.json({ success: true, message: 'Job assigned to driver', jobId: idToAssign });
  } catch (err) {
    console.error('Assign job error:', err);
    res.status(500).json({ error: 'Server error assigning job' });
  }
});

/* ------------------- COMPLETE JOB ------------------- */
app.post('/complete-job', async (req, res) => {
  try {
    const { jobId, driverEmail } = req.body;
    if (!jobId || !driverEmail) return res.status(400).json({ error: 'Missing jobId or driverEmail' });

    const { data: job, error: jobError } = await supabase
      .from('pending_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobError || !job) return res.status(404).json({ error: 'Job not found' });

    const completedJob = {
      ...job,
      driverEmail: driverEmail.trim().toLowerCase(),
      completedAt: new Date(),
      status: 'completed'
    };

    delete completedJob.id; // Let Supabase assign a new ID

    const { error: insertError } = await supabase
      .from('completed_jobs')
      .insert([completedJob]);

    if (insertError) return res.status(500).json({ error: 'Failed to save completed job' });

    await supabase.from('pending_jobs').delete().eq('id', jobId);

    res.json({ success: true, message: 'Job completed' });
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

/* ------------------- START SERVER ------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

module.exports = app;
