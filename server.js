require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL
}));
app.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Route de test
app.get('/', (req, res) => {
  res.json({ message: 'Backend SkyBlue opérationnel ✅' });
});

// Route santé pour UptimeRobot
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    service: 'SkyBlue Backend'
  });
});

// ============================================
// BICTORYS PAYMENT INTEGRATION
// ============================================

// Créer un paiement Bictorys
app.post('/api/create-bictorys-payment', async (req, res) => {
  try {
    const { amount, name, email, phone } = req.body;

    console.log('📧 Création paiement Bictorys:', { amount, name, email, phone });

    // Validation des données
    if (!amount || !name || !email) {
      return res.status(400).json({ error: 'Données manquantes' });
    }

    // Convertir EUR en XOF (1 EUR = 656 XOF)
    const amountXOF = Math.round(amount * 656);

    // Préparer les données pour Bictorys
    const bictorysData = {
      amount: amountXOF,
      currency: 'XOF',
      country: 'SN',
      successRedirectUrl: `${process.env.FRONTEND_URL}/don-success?amount=${amount}&name=${encodeURIComponent(name)}&email=${encodeURIComponent(email)}`,
      errorRedirectUrl: `${process.env.FRONTEND_URL}/faire-un-don?error=payment_failed`,
      customer: {
        name: name,
        email: email,
        phone: phone || '+221000000000', // Téléphone par défaut si non fourni
        country: 'SN',
        locale: 'fr-FR'
      },
      merchantReference: `DON-${Date.now()}`, // Référence unique
      paymentReference: `SKYBLUE-${Date.now()}`
    };

    console.log('📤 Envoi à Bictorys:', bictorysData);

    // Appel API Bictorys (Mode CHECKOUT)
    const bictorysResponse = await fetch('https://api.test.bictorys.com/pay/v1/charges', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': process.env.BICTORYS_PUBLIC_KEY
      },
      body: JSON.stringify(bictorysData)
    });

    const responseText = await bictorysResponse.text();
    console.log('📥 Réponse Bictorys (brute):', responseText);

    let bictorysResult;
    try {
      bictorysResult = JSON.parse(responseText);
    } catch (parseError) {
      console.error('❌ Erreur parsing JSON:', parseError);
      return res.status(500).json({ 
        error: 'Erreur serveur Bictorys', 
        details: responseText 
      });
    }

    if (!bictorysResponse.ok) {
      console.error('❌ Erreur Bictorys:', bictorysResult);
      return res.status(bictorysResponse.status).json({ 
        error: 'Erreur création paiement',
        details: bictorysResult
      });
    }

    console.log('✅ Paiement Bictorys créé:', bictorysResult);

    // Retourner l'URL de paiement (Bictorys utilise "link")
    const checkoutUrl = bictorysResult.link || bictorysResult.checkoutUrl || bictorysResult.paymentUrl || bictorysResult.url;

    if (!checkoutUrl) {
      console.error('❌ Pas d\'URL de checkout dans la réponse:', bictorysResult);
      return res.status(500).json({ 
        error: 'URL de paiement manquante',
        details: bictorysResult
      });
    }
    
    console.log('🔗 URL de paiement:', checkoutUrl);

    res.json({ 
      checkoutUrl: checkoutUrl,
      transactionId: bictorysResult.transactionId || bictorysResult.id,
      amountXOF: amountXOF
    });

  } catch (error) {
    console.error('❌ Erreur serveur:', error);
    res.status(500).json({ 
      error: 'Erreur serveur', 
      message: error.message 
    });
  }
});

// ============================================
// WEBHOOK BICTORYS
// ============================================

app.post('/webhook/bictorys', async (req, res) => {
  console.log('🔔 Webhook Bictorys reçu');
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);

  try {
    // Vérifier la signature du webhook (si Bictorys en fournit une)
    const signature = req.headers['x-bictorys-signature'] || req.headers['x-signature'];
    
    // TODO: Vérifier la signature avec la clé secrète si nécessaire
    // Pour l'instant, on accepte tous les webhooks en mode test

    const event = req.body;

    // Gérer les différents types d'événements Bictorys
    if (event.status === 'SUCCESS' || event.status === 'COMPLETED' || event.eventType === 'payment.success') {
      console.log('✅ Paiement réussi !');

      // Extraire les données du paiement
      const amount = event.amount || event.data?.amount;
      const amountXOF = amount;
      const amountEUR = Math.round((amountXOF / 656) * 100) / 100; // Reconvertir en EUR

      const donorEmail = event.customer?.email || event.data?.customer?.email;
      const donorName = event.customer?.name || event.data?.customer?.name;
      const transactionId = event.transactionId || event.id || event.data?.id;
      const paymentReference = event.paymentReference || event.merchantReference;

      // Enregistrer le don dans Supabase
      const { data, error } = await supabase
        .from('donations')
        .insert([
          {
            amount: amountEUR,
            donor_name: donorName || 'Donateur anonyme',
            donor_email: donorEmail,
            payment_method: 'bictorys',
            status: 'completed',
            stripe_session_id: transactionId, // On utilise ce champ pour l'ID Bictorys
            message: `Don via Bictorys - ${amountXOF} XOF`,
            created_at: new Date().toISOString()
          }
        ]);

      if (error) {
        console.error('❌ Erreur Supabase:', error);
        return res.status(500).json({ error: 'Erreur base de données' });
      }

      console.log('✅ Don enregistré dans Supabase:', data);

      // Note: L'email sera envoyé par le frontend (comme avec Stripe)
      
      res.json({ received: true, status: 'success' });
    } else if (event.status === 'FAILED' || event.status === 'CANCELLED' || event.eventType === 'payment.failed') {
      console.log('❌ Paiement échoué ou annulé');
      res.json({ received: true, status: 'failed' });
    } else {
      console.log('ℹ️ Événement non géré:', event.status || event.eventType);
      res.json({ received: true, status: 'ignored' });
    }

  } catch (error) {
    console.error('❌ Erreur webhook:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// AUTRES ROUTES (Contact, etc.)
// ============================================

// Route pour les messages de contact
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    const { data, error } = await supabase
      .from('messages')
      .insert([
        {
          name,
          email,
          subject,
          message,
          status: 'unread',
          created_at: new Date().toISOString()
        }
      ]);

    if (error) throw error;

    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Erreur contact:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Démarrer le serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📍 Frontend autorisé: ${process.env.FRONTEND_URL}`);
  console.log(`💳 Bictorys configuré en mode TEST`);
});