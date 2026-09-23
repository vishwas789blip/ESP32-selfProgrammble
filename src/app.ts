import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { env } from './config/env.js';

import { authRoutes } from './routes/authRoutes.js';
import { deviceRoutes } from './routes/deviceRoutes.js';
import { sensorRoutes } from './routes/sensorRoutes.js';
import { actuatorRoutes } from './routes/actuatorRoutes.js';
import { automationRoutes } from './routes/automationRoutes.js';
import { eventRoutes } from './routes/eventRoutes.js';
import { aiRoutes } from './routes/aiRoutes.js';

import { errorMiddleware } from './middleware/errorMiddleware.js';
import { notFoundMiddleware } from './middleware/notFoundMiddleware.js';

export const app = express();


// =====================================================
// CORS
// =====================================================

const allowedOrigins = [
  'https://esp32-iot-platform.vercel.app',
  env.CLIENT_URL,
  'http://localhost:5173',
].filter(Boolean);

const corsOptions = {
  origin: (
    origin: string | undefined,
    callback: (error: Error | null, allow?: boolean) => void
  ) => {

    // Allow requests without Origin
    // Useful for Postman / ESP32 / server-to-server
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.log('[CORS] Blocked origin:', origin);

    return callback(
      new Error(`CORS blocked origin: ${origin}`)
    );
  },

  methods: [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',
  ],

  allowedHeaders: [
    'Content-Type',
    'Authorization',
  ],

  credentials: true,

  optionsSuccessStatus: 204,
};


// CORS MUST BE BEFORE ROUTES
app.use(cors(corsOptions));


// Explicit preflight handling
app.options('*', cors(corsOptions));


// =====================================================
// SECURITY
// =====================================================

app.use(helmet());


// =====================================================
// BODY
// =====================================================

app.use(express.json({
  limit: '100kb',
}));


// =====================================================
// LOGGING
// =====================================================

app.use(
  morgan(
    env.NODE_ENV === 'production'
      ? 'combined'
      : 'dev'
  )
);


// =====================================================
// ROOT
// =====================================================

app.get('/', (_req, res) => {

  res.json({
    name: 'ESP32 Self-Programmable API',
    version: '1.0.0',
    status: 'running',
  });

});


// =====================================================
// HEALTH
// =====================================================

app.get('/api/health', (_req, res) => {

  res.json({
    success: true,

    data: {
      status: 'ok',
      service: 'esp32-self-programmable-backend',
    },
  });

});


// =====================================================
// ROUTES
// =====================================================

app.use('/api/auth', authRoutes);

app.use('/api/devices', deviceRoutes);

app.use('/api', sensorRoutes);

app.use('/api', actuatorRoutes);

app.use('/api/automations', automationRoutes);

app.use('/api/events', eventRoutes);

app.use('/api/ai', aiRoutes);


// =====================================================
// ERROR HANDLING
// =====================================================

app.use(notFoundMiddleware);

app.use(errorMiddleware);