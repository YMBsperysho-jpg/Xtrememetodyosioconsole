/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

// Ensure Database exists
const DB_FILE = path.join(process.cwd(), 'license-db.json');

interface DbSchema {
  licenses: Array<{
    key: string;
    tier: 'trial' | 'monthly' | '3month' | 'admin';
    durationDays: number;
    createdAt: string;
    expiresAt: string;
    isActive: boolean;
    buyerEmail: string;
  }>;
  paymentConfig: {
    payoutMethod: 'stripe_link' | 'paypal' | 'crypto' | 'whatsapp';
    payoutDetails: string;
    customMessage: string;
  };
  simulatedSales: Array<{
    id: string;
    buyerEmail: string;
    tier: string;
    amount: number;
    timestamp: string;
    key: string;
  }>;
}

const DEFAULT_DB: DbSchema = {
  licenses: [
    // Pre-populate some master test keys for direct access
    {
      key: 'XTRA-VIP-TRIAL-CODE',
      tier: 'trial',
      durationDays: 14,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      isActive: true,
      buyerEmail: 'tester@xtrametod.com'
    },
    {
      key: 'XTRA-MASTER-ADMIN-PASS',
      tier: 'admin',
      durationDays: 9999,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 9999 * 24 * 60 * 60 * 1000).toISOString(),
      isActive: true,
      buyerEmail: 'admin@xtrametod.com'
    }
  ],
  paymentConfig: {
    payoutMethod: 'whatsapp',
    payoutDetails: '+1234567890',
    customMessage: '¡Hola! Me interesa adquirir la licencia premium de XTRA METOD para desbloquear todos los ajustes e ingeniería avanzada de Android.'
  },
  simulatedSales: []
};

function readDb(): DbSchema {
  try {
    if (fs.existsSync(DB_FILE)) {
      const content = fs.readFileSync(DB_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error('Error reading DB, falling back to defaults', error);
  }
  // Write default DB if not present
  writeDb(DEFAULT_DB);
  return DEFAULT_DB;
}

function writeDb(data: DbSchema) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error writing DB', error);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Initialize Gemini Client safely
  let ai: GoogleGenAI | null = null;
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey && apiKey !== 'MY_GEMINI_API_KEY') {
    ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  } else {
    console.warn('GEMINI_API_KEY is not set or using default placeholder. Gemini features will run in mock/simulated mode.');
  }

  // --- API Routes ---

  // Verify license key
  app.post('/api/license/verify', (req, res) => {
    const { key } = req.body;
    if (!key) {
      return res.status(400).json({ error: 'La clave de licencia es requerida.' });
    }

    const db = readDb();
    const cleanKey = key.trim().toUpperCase();
    const license = db.licenses.find(l => l.key.toUpperCase() === cleanKey);

    if (!license) {
      return res.json({ valid: false, error: 'La clave ingresada no es válida o no existe.' });
    }

    const expiresAtDate = new Date(license.expiresAt);
    const isExpired = expiresAtDate.getTime() < Date.now();

    if (isExpired) {
      return res.json({ valid: false, error: 'Esta clave de licencia ha expirado.', tier: license.tier });
    }

    if (!license.isActive) {
      return res.json({ valid: false, error: 'Esta clave de licencia ha sido desactivada por el administrador.' });
    }

    res.json({
      valid: true,
      tier: license.tier,
      expiresAt: license.expiresAt,
      buyerEmail: license.buyerEmail
    });
  });

  // Generate new license key (Used by Checkout or Admin Portal)
  app.post('/api/license/generate', (req, res) => {
    const { tier, email } = req.body;
    if (!tier || !email) {
      return res.status(400).json({ error: 'Falta el tier (trial, monthly, 3month) o el correo del comprador.' });
    }

    const db = readDb();
    
    // Determine duration
    let durationDays = 14;
    let amount = 79;
    if (tier === 'monthly') {
      durationDays = 30;
      amount = 169;
    } else if (tier === '3month') {
      durationDays = 90;
      amount = 299;
    }

    // Generate Key
    const randomHex = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1).toUpperCase();
    const generatedKey = `XTRA-${tier.toUpperCase()}-${randomHex()}-${randomHex()}`;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

    const newLicense = {
      key: generatedKey,
      tier: tier as 'trial' | 'monthly' | '3month' | 'admin',
      durationDays,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      isActive: true,
      buyerEmail: email
    };

    db.licenses.push(newLicense);

    // Save simulated sale
    const saleId = `SAL-${randomHex()}-${randomHex()}`;
    db.simulatedSales.push({
      id: saleId,
      buyerEmail: email,
      tier,
      amount,
      timestamp: now.toISOString(),
      key: generatedKey
    });

    writeDb(db);

    res.json({
      success: true,
      license: newLicense
    });
  });

  // Get current payments configuration
  app.get('/api/payment/config', (req, res) => {
    const db = readDb();
    res.json(db.paymentConfig);
  });

  // Update payments configuration (Admin only)
  app.post('/api/payment/config', (req, res) => {
    const { payoutMethod, payoutDetails, customMessage } = req.body;
    
    const db = readDb();
    db.paymentConfig = {
      payoutMethod: payoutMethod || db.paymentConfig.payoutMethod,
      payoutDetails: payoutDetails !== undefined ? payoutDetails : db.paymentConfig.payoutDetails,
      customMessage: customMessage !== undefined ? customMessage : db.paymentConfig.customMessage
    };

    writeDb(db);
    res.json({ success: true, paymentConfig: db.paymentConfig });
  });

  // Get Admin statistics
  app.get('/api/admin/stats', (req, res) => {
    const db = readDb();
    const totalSalesAmount = db.simulatedSales.reduce((acc, sale) => acc + sale.amount, 0);
    
    res.json({
      totalLicenses: db.licenses.length,
      totalSalesCount: db.simulatedSales.length,
      totalSalesAmount,
      licenses: db.licenses,
      sales: db.simulatedSales
    });
  });

  // Gemini API helper for Android/ADB commands
  app.post('/api/gemini-adb', async (req, res) => {
    const { prompt, currentCommand } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Falta la consulta para la Inteligencia Artificial.' });
    }

    try {
      if (!ai) {
        // Fallback if no real API key is injected
        return res.json({
          response: `[SIMULADOR SIN LLAVE] Para resolver tu consulta sobre "${prompt}":
Puedes usar este comando ADB en tu teléfono:
\`adb shell pm list packages | grep "${prompt.toLowerCase()}"\`

*Nota: Añade un API Key real en Settings > Secrets para recibir respuestas hiper-avanzadas personalizadas con Gemini AI.*`
        });
      }

      const systemInstruction = `Eres "XTRA METOD CONSOLE ENGINE AI", una inteligencia artificial experta de nivel militar en el sistema operativo Android, ADB (Android Debug Bridge), Fastboot, Modo Ingeniero (Engineer Mode) y optimizaciones de kernel / software.
Tu misión es guiar al usuario que está usando una consola premium para modificar su teléfono.
Siempre sé profesional, preciso, de tono técnico pero comprensible y amigable.
Si el usuario pregunta por comandos ADB, proporciónale comandos reales explicados paso a paso con los parámetros correctos.
Si pregunta cómo resolver un error, explícale el por qué y bríndale la solución exacta.
Manten tus respuestas enfocadas en el ecosistema Android y mantén un formato Markdown limpio.`;

      const userMessage = currentCommand 
        ? `Tengo una consulta sobre el comando actual que estoy revisando: "${currentCommand}". Mi pregunta es: ${prompt}`
        : prompt;

      const response = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: userMessage,
        config: {
          systemInstruction,
          temperature: 0.7,
        }
      });

      res.json({ response: response.text });
    } catch (error: any) {
      console.error('Error invoking Gemini:', error);
      res.status(500).json({ 
        error: 'Error al contactar con Gemini AI.', 
        details: error.message || error 
      });
    }
  });

  // --- Serve Client ---

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[XTRA METOD CONSOLE SERVER] Corriendo exitosamente en http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Error inicializando el servidor:', err);
});
