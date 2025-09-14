require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const streamBuffers = require('stream-buffers');

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

/* ------------------- NODEMAILER ------------------- */
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

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
    notes
  } = req.body;

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
        notes: notes || '',
        distanceKm: distanceKm ? distanceKm.toString() : 'N/A',
        durationMin: durationMin ? durationMin.toString() : 'N/A'
      },
      success_url: 'https://bookingform-pi.vercel.app/success.html',
      cancel_url: 'https://bookingform-pi.vercel.app/cancel.html'
    });

    res.status(200).json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Stripe session error:', err);
    res.status(500).json({ error: 'Stripe session creation failed.' });
  }
});

/* ------------------- DRIVER LOGIN ------------------- */
app.post('/driver-login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    // Fetch active jobs for this driver from Supabase
    const { data: jobs, error } = await supabase
      .from('driver_jobs')
      .select('*')
      .ilike('driverEmail', email)
      .order('assignedAt', { ascending: true });

    if (error) {
      console.error('Supabase driver jobs error:', error);
      return res.status(500).json({ error: 'Failed to fetch driver jobs' });
    }

    // Fetch completed jobs for this driver
    const { data: completedJobs, error: completedError } = await supabase
      .from('completed_jobs')
      .select('*')
      .ilike('driverEmail', email)
      .order('completedAt', { ascending: false });

    if (completedError) {
      console.error('Supabase completed jobs error:', completedError);
      return res.status(500).json({ error: 'Failed to fetch completed jobs' });
    }

    res.json({
      jobs: jobs || [],
      completed: completedJobs || []
    });
  } catch (err) {
    console.error('Driver login unexpected error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

/* ------------------- DRIVER JOB PAYOUT ------------------- */
function calculateDriverPayout(clientFare) {
  const net = clientFare / 1.45;
  return parseFloat(net.toFixed(2));
}

/* ------------------- ASSIGN JOB TO DRIVER ------------------- */
app.post('/assign-job', async (req, res) => {
  const { driverEmail, bookingData } = req.body;
  if (!driverEmail || !bookingData) return res.status(400).json({ error: 'Missing driverEmail or bookingData' });

  try {
    const driverPay = calculateDriverPayout(parseFloat(bookingData.totalFare));

    const newJob = {
      id: bookingData.id,
      driverEmail,
      bookingData,
      driverPay,
      assignedAt: new Date().toISOString()
    };

    const { error } = await supabase.from('driver_jobs').insert([newJob]);
    if (error) {
      console.error('Supabase insert driver job error:', error);
      return res.status(500).json({ error: 'Failed to assign job' });
    }

    // Send driver email
    await transporter.sendMail({
      from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
      to: driverEmail,
      subject: `New Chauffeur Job Assigned`,
      html: `
        <h2>New Job Assigned</h2>
        <p><strong>Name:</strong> ${bookingData.name}</p>
        <p><strong>Pickup:</strong> ${bookingData.pickup}</p>
        <p><strong>Dropoff:</strong> ${bookingData.dropoff}</p>
        <p><strong>Pickup Time:</strong> ${bookingData.datetime}</p>
        <p><strong>Vehicle Type:</strong> ${bookingData.vehicleType}</p>
        <p><strong>Driver Payout:</strong> $${driverPay}</p>
        <p><strong>Notes:</strong> ${bookingData.notes || 'None'}</p>
        <p>Please login to your driver dashboard to view full details.</p>
      `
    });

    res.json({ message: 'Job assigned successfully', jobId: newJob.id });
  } catch (err) {
    console.error('Assign job unexpected error:', err);
    res.status(500).json({ error: 'Server error assigning job' });
  }
});

/* ------------------- DRIVER RESPONSE ------------------- */
app.post('/driver-response', async (req, res) => {
  const { driverEmail, jobId, confirmed } = req.body;
  if (!driverEmail || !jobId || typeof confirmed !== 'boolean')
    return res.status(400).json({ error: 'Missing required fields or invalid data' });

  try {
    const { data: jobDataArr, error } = await supabase
      .from('driver_jobs')
      .select('*')
      .eq('id', jobId)
      .ilike('driverEmail', driverEmail);

    if (error || !jobDataArr || jobDataArr.length === 0) {
      return res.status(404).json({ error: 'Job not found for this driver' });
    }

    const jobData = jobDataArr[0];

    if (confirmed) {
      await supabase
        .from('driver_jobs')
        .update({ driverConfirmed: true, responseAt: new Date().toISOString() })
        .eq('id', jobId);
    } else {
      await supabase.from('driver_jobs').delete().eq('id', jobId);
    }

    // Send admin email
    await transporter.sendMail({
      from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO,
      subject: `Driver Job Response - ${confirmed ? 'CONFIRMED' : 'REFUSED'} - ${jobId}`,
      html: `
        <p>Driver <strong>${driverEmail}</strong> has <strong>${confirmed ? 'CONFIRMED ✅' : 'REFUSED ❌'}</strong> the job.</p>
        <p><strong>Name:</strong> ${jobData.bookingData.name}</p>
        <p><strong>Email:</strong> ${jobData.bookingData.email}</p>
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
    res.status(500).json({ error: 'Server error recording driver response' });
  }
});

/* ------------------- DRIVER COMPLETE ------------------- */
app.post('/driver-complete', async (req, res) => {
  const { driverEmail, jobId } = req.body;
  if (!driverEmail || !jobId)
    return res.status(400).json({ error: 'Missing required fields' });

  try {
    const { data: jobDataArr, error } = await supabase
      .from('driver_jobs')
      .select('*')
      .eq('id', jobId)
      .ilike('driverEmail', driverEmail);

    if (error || !jobDataArr || jobDataArr.length === 0) {
      return res.status(404).json({ error: 'Job not found for this driver' });
    }

    const jobData = jobDataArr[0];

    const jobToInsert = {
      id: jobData.id,
      driverEmail: jobData.driverEmail,
      bookingData: jobData.bookingData,
      driverPay: jobData.driverPay,
      assignedAt: jobData.assignedAt,
      completedAt: new Date().toISOString()
    };

    // Insert into completed_jobs
    const { error: insertError } = await supabase
      .from('completed_jobs')
      .upsert([jobToInsert], { onConflict: ['id'] });

    if (insertError) {
      console.error('Supabase completed_jobs insert error:', insertError);
      return res.status(500).json({ error: 'Failed to mark job as completed' });
    }

    // Remove from active driver_jobs
    await supabase.from('driver_jobs').delete().eq('id', jobId);

    // Notify admin
    await transporter.sendMail({
      from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO,
      subject: `Driver Job Completed - ${jobId}`,
      html: `
        <p>Driver <strong>${driverEmail}</strong> has <strong>COMPLETED ✅</strong> the job <strong>${jobId}</strong>.</p>
        <p><strong>Name:</strong> ${jobData.bookingData.name}</p>
        <p><strong>Email:</strong> ${jobData.bookingData.email}</p>
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

/* ------------------- PENDING BOOKINGS ------------------- */
app.get('/pending-bookings', async (req, res) => {
  try {
    const { data: bookings, error: bookingsError } = await supabase
      .from('bookings')
      .select('*');
    if (bookingsError) throw bookingsError;

    const { data: driverJobs } = await supabase
      .from('driver_jobs')
      .select('*');

    const { data: completedJobs } = await supabase
      .from('completed_jobs')
      .select('*');

    const assignedBookingIds = driverJobs?.map(j => j.bookingData.id) || [];
    const completedBookingIds = completedJobs?.map(c => c.id) || [];

    const pending = bookings.filter(
      b => !assignedBookingIds.includes(b.id) && !completedBookingIds.includes(b.id)
    );

    res.json(pending);
  } catch (err) {
    console.error('Pending bookings error:', err);
    res.status(500).json({ error: 'Server error fetching pending bookings' });
  }
});

/* ------------------- COMPLETED JOBS ------------------- */
app.get('/completed-jobs', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('completed_jobs')
      .select('*')
      .order('completedAt', { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('Completed jobs error:', err);
    res.status(500).json({ error: 'Server error fetching completed jobs' });
  }
});

/* ------------------- ADMIN DRIVERS ------------------- */
app.get('/drivers', async (req, res) => {
  try {
    const { data, error } = await supabase.from('drivers').select('*');
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Drivers fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch drivers' });
  }
});

app.delete('/drivers/:email', async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    const { error } = await supabase
      .from('drivers')
      .delete()
      .ilike('email', email);
    if (error) throw error;
    res.json({ message: `Driver with email ${email} deleted` });
  } catch (err) {
    console.error('Delete driver error:', err);
    res.status(500).json({ error: 'Failed to delete driver' });
  }
});

/* ------------------- ADMIN JOBS ------------------- */
app.get('/jobs', async (req, res) => {
  try {
    const { data, error } = await supabase.from('driver_jobs').select('*');
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Jobs fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

app.delete('/jobs/:id', async (req, res) => {
  try {
    const jobId = req.params.id;
    const { error } = await supabase.from('driver_jobs').delete().eq('id', jobId);
    if (error) throw error;
    res.json({ message: `Job with ID ${jobId} deleted` });
  } catch (err) {
    console.error('Delete job error:', err);
    res.status(500).json({ error: 'Failed to delete job' });
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

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Driver history error:', err);
    res.status(500).json({ error: 'Server error fetching driver history' });
  }
});

/* ------------------- PARTNER FORM SUBMISSION ------------------- */
app.post('/partner-form', upload.fields([
  { name: 'insuranceFile', maxCount: 1 },
  { name: 'regoFile', maxCount: 1 },
  { name: 'licenceFile', maxCount: 1 }
]), async (req, res) => {
  try {
    const data = req.body;
    const files = req.files;

    // Save to Supabase
    const record = { ...data, submittedAt: new Date().toISOString() };
    const { error } = await supabase.from('drivers').insert([record]);
    if (error) throw error;

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

/* ------------------- RENEWAL REMINDERS ------------------- */
cron.schedule('0 9 * * *', async () => {
  try {
    const { data: drivers, error } = await supabase.from('drivers').select('*');
    if (error) throw error;

    const today = new Date();
    for (const driver of drivers) {
      const regoDate = new Date(driver.regoExpiry);
      const insuranceDate = new Date(driver.insuranceExpiry);

      for (const item of [{ type: 'Registration', date: regoDate }, { type: 'Insurance', date: insuranceDate }]) {
        const diffDays = Math.ceil((item.date - today) / (1000 * 60 * 60 * 24));
        if (diffDays === 30) {
          await transporter.sendMail({
            from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
            to: process.env.EMAIL_TO,
            subject: `${item.type} Renewal Reminder - ${driver.fullName}`,
            text: `${driver.fullName}'s ${item.type} expires in 30 days on ${item.date.toDateString()}.`
          });
        }
      }
    }
  } catch (err) {
    console.error('Cron reminder error:', err);
  }
});

/* ------------------- START SERVER ------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
