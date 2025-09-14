require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ------------------- EMAIL TRANSPORTER -------------------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ------------------- PENDING JOBS -------------------
app.get('/pending-jobs', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pending_jobs')
      .select('*')
      .order('pickuptime', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error fetching pending jobs:', err);
    res.status(500).json({ error: 'Failed to fetch pending jobs' });
  }
});

// ------------------- COMPLETED JOBS -------------------
app.get('/completed-jobs', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('completed_jobs')
      .select('*')
      .order('completedAt', { ascending: false });
    if (error) throw error;

    // Map so admin dashboard can read bookingData + driverEmail
    const mapped = (data || []).map(job => ({
      id: job.id,
      driverEmail: job.driverEmail,
      bookingData: job.bookingData,
      driverPay: job.driverPay,
      assignedAt: job.assignedAt,
      completedAt: job.completedAt
    }));

    res.json(mapped);
  } catch (err) {
    console.error('Error fetching completed jobs:', err);
    res.status(500).json({ error: 'Failed to fetch completed jobs' });
  }
});

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

    if (fetchError || !pendingData) {
      console.error('Pending job fetch error:', fetchError);
      return res.status(404).json({ error: 'Booking not found' });
    }

    const driverPay = parseFloat(pendingData.fare) * 0.8;

    // Insert into completed_jobs
    const { error: insertError } = await supabase.from('completed_jobs').insert([{
      id: pendingData.id,
      driverEmail: bookingData.assignedto,
      bookingData: pendingData,
      driverPay,
      assignedAt: pendingData.assignedat || new Date().toISOString(),
      completedAt: new Date().toISOString()
    }]);

    if (insertError) {
      console.error('Error inserting completed job:', insertError);
      return res.status(500).json({ error: 'Error assigning job' });
    }

    // Delete from pending_jobs
    const { error: deleteError } = await supabase
      .from('pending_jobs')
      .delete()
      .eq('id', bookingData.id);

    if (deleteError) console.error('Error deleting pending job:', deleteError);

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
      .eq('driverEmail', email);

    res.json({ jobs: pendingJobs || [], completed: completedJobs || [] });
  } catch (err) {
    console.error('Driver login error:', err);
    res.status(500).json({ error: 'Failed to fetch driver jobs' });
  }
});

// ------------------- CRON JOB FOR DRIVER RENEWALS -------------------
cron.schedule('0 9 * * *', async () => {
  try {
    const { data: drivers } = await supabase
      .from('drivers')
      .select('*');

    if (!drivers) return;

    const today = new Date();

    drivers.forEach(driver => {
      const regoDate = new Date(driver.regoexpiry);
      const insuranceDate = new Date(driver.insuranceexpiry);

      [{ type: 'Registration', date: regoDate }, { type: 'Insurance', date: insuranceDate }].forEach(item => {
        const diffDays = Math.ceil((item.date - today) / (1000 * 60 * 60 * 24));
        if (diffDays === 30) {
          transporter.sendMail({
            from: `Chauffeur de Luxe <${process.env.EMAIL_USER}>`,
            to: process.env.EMAIL_TO,
            subject: `${item.type} Renewal Reminder - ${driver.name}`,
            text: `${driver.name}'s ${item.type} expires in 30 days on ${item.date.toDateString()}.`
          }).catch(console.error);
        }
      });
    });
  } catch (err) {
    console.error('Driver renewal cron error:', err);
  }
});

// ------------------- STRIPE PAYMENT ENDPOINT -------------------
app.post('/create-payment-intent', async (req, res) => {
  const { amount, currency = 'aud' } = req.body;
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // convert to cents
      currency
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Payment failed' });
  }
});

// ------------------- START SERVER -------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
