require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
//const emailjs = require('@emailjs/nodejs');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Middleware CORS
app.use(cors({
  origin: process.env.FRONTEND_URL
}));

// ========================================
// ⚠️ IMPORTANT : WEBHOOK AVANT express.json()
// ========================================
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.log(`❌ Webhook Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('✅ Webhook reçu:', event.type);

  // Paiement réussi
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    console.log('💰 Paiement réussi:', session.id);

    // Enregistrer dans Supabase
    try {
      const { data, error } = await supabase
        .from('donations')
        .insert({
          name: session.metadata.name || null,
          email: session.customer_details.email,
          amount: session.amount_total / 100,
          is_anonymous: session.metadata.isAnonymous === 'true',
          accept_newsletter: session.metadata.acceptNewsletter === 'true',
          stripe_payment_id: session.payment_intent,
          stripe_session_id: session.id,
          status: 'succeeded'
        });

      if (error) {
        console.error('❌ Erreur Supabase:', error);
      } else {
        console.log('✅ Don enregistré dans Supabase');
      }
    } catch (dbError) {
      console.error('❌ Erreur DB:', dbError);
    }

    // Envoyer email de confirmation avec EmailJS
    
  }

  res.json({ received: true });
});

// ========================================
// ⚠️ MAINTENANT ON PEUT METTRE express.json()
// ========================================
app.use(express.json());

// ========================================
// ROUTE PRINCIPALE : Créer une session Stripe Checkout
// ========================================
app.post('/api/create-checkout-session', async (req, res) => {
  const { amount, email, name, isAnonymous, acceptNewsletter } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: 'Don à SkyBlue',
              description: 'Soutien aux orphelins',
            },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/don-success`,
      cancel_url: `${process.env.FRONTEND_URL}/faire-un-don`,
      customer_email: email,
      metadata: {
        name: name || '',
        isAnonymous: isAnonymous.toString(),
        acceptNewsletter: acceptNewsletter.toString(),
      },
    });

    res.json({ 
      id: session.id,
      url: session.url
    });
  } catch (error) {
    console.error('Erreur création session:', error);
    res.status(500).json({ error: error.message });
  }
});

// Route de test
app.get('/', (req, res) => {
  res.json({ message: 'Backend SkyBlue opérationnel ✅' });
});

// Démarrer le serveur
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📍 Frontend autorisé: ${process.env.FRONTEND_URL}`);
  console.log(`💳 Stripe configuré en mode TEST`);
  console.log(`📧 EmailJS configuré`);
});